// Huecos iguales entre columnas en todas las tablas.
//
// Con table-layout: fixed y sin anchos, todas las columnas miden lo mismo, pero el
// hueco que se ve entre dos columnas es lo que le sobra a cada una, y eso depende
// de lo que ocupe su contenido y de hacia dónde esté alineado: entre «Servicio» y
// «Cuenta» quedaba un vacío enorme y entre un importe alineado a la derecha y la
// frecuencia que le sigue, casi nada.
//
// Aquí cada columna mide exactamente su contenido más ancho y el espacio que sobra
// hasta llenar la tabla se reparte a partes iguales entre columna y columna, como
// relleno lateral de las celdas. Al ir en el relleno, el hueco no depende de la
// alineación. Los márgenes de los extremos (borde → primera columna, última
// columna → borde) se quedan con el relleno que ya tenían en la hoja de estilos.
//
// Se recalcula sola cuando cambia el contenido de una tabla (MutationObserver) o
// su ancho (ResizeObserver). Si el contenido no cabe con un hueco mínimo, la tabla
// se queda como la deja su CSS (con sus recortes con «…»).
;(function () {
    "use strict"

    if (typeof window === "undefined" || typeof ResizeObserver === "undefined") return

    const CLASE_MIDIENDO = "tablaMidiendo"
    const CLASE_ACTIVA = "tablaHuecosIguales"
    const HUECO_MINIMO = 16
    // Rejillas en las que interesa que las columnas midan lo mismo, no los huecos.
    const EXCLUIDAS = ".calendarioTable"

    const pendientes = new Set()
    const anchoObservado = new WeakMap()
    const registradas = new WeakSet()
    let frame = 0

    function columnasDeFila(fila) {
        let total = 0
        for (const celda of fila.cells) total += celda.colSpan || 1
        return total
    }

    /** Primera fila sin celdas combinadas: sus celdas dan el ancho de cada columna. */
    function filaDeReferencia(tabla) {
        let columnas = 0
        for (const fila of tabla.rows) columnas = Math.max(columnas, columnasDeFila(fila))
        for (const fila of tabla.rows) {
            if (fila.cells.length === columnas) return fila
        }
        return null
    }

    function colgroupPropio(tabla, columnas) {
        let grupo = tabla.querySelector(":scope > colgroup")
        if (grupo && grupo.children.length === columnas) return grupo
        if (grupo && !grupo.hasAttribute("data-huecos")) return null
        if (grupo) grupo.remove()
        grupo = document.createElement("colgroup")
        grupo.setAttribute("data-huecos", "")
        for (let i = 0; i < columnas; i++) grupo.appendChild(document.createElement("col"))
        tabla.insertBefore(grupo, tabla.firstChild)
        return grupo
    }

    // Deja la tabla como la pinta su CSS. El colgroup propio se conserva vacío: quitarlo
    // y volverlo a poner en cada medida sería un cambio que el MutationObserver
    // tomaría por contenido nuevo, en bucle.
    function limpiar(tabla) {
        if (!tabla.classList.contains(CLASE_ACTIVA)) return
        tabla.classList.remove(CLASE_ACTIVA)
        const grupo = tabla.querySelector(":scope > colgroup")
        if (grupo) for (const col of grupo.children) col.style.width = ""
        for (const fila of tabla.rows) {
            for (const celda of fila.cells) {
                celda.style.removeProperty("padding-left")
                celda.style.removeProperty("padding-right")
            }
        }
    }

    // El mayor relleno de la primera y la última columna en las primeras filas: la
    // cabecera y las celdas no siempre llevan el mismo (la de acciones, por ejemplo).
    const FILAS_PARA_EXTREMOS = 20

    function rellenoDeLosExtremos(tabla, columnas) {
        let bordeIzq = 0
        let bordeDer = 0
        const filas = Array.from(tabla.rows).slice(0, FILAS_PARA_EXTREMOS)
        for (const fila of filas) {
            const primera = fila.cells[0]
            const ultima = fila.cells[fila.cells.length - 1]
            if (!primera || columnasDeFila(fila) !== columnas) continue
            bordeIzq = Math.max(bordeIzq, parseFloat(getComputedStyle(primera).paddingLeft) || 0)
            bordeDer = Math.max(bordeDer, parseFloat(getComputedStyle(ultima).paddingRight) || 0)
        }
        return { bordeIzq, bordeDer }
    }

    // Cambiar el ancho de la tabla para medirla puede recortar el scroll de los
    // contenedores (y de la página) aunque no llegue a pintarse nada.
    function guardarScroll(nodo) {
        const guardados = []
        for (let el = nodo.parentElement; el; el = el.parentElement) {
            if (el.scrollTop || el.scrollLeft) guardados.push([el, el.scrollTop, el.scrollLeft])
        }
        const x = window.scrollX
        const y = window.scrollY
        return function () {
            for (const [el, top, left] of guardados) {
                el.scrollTop = top
                el.scrollLeft = left
            }
            if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y)
        }
    }

    function ajustar(tabla) {
        if (!tabla.isConnected || tabla.matches(EXCLUIDAS)) return
        if (!tabla.getClientRects().length) return
        if (getComputedStyle(tabla).display !== "table") return limpiar(tabla)

        const referencia = filaDeReferencia(tabla)
        const columnas = referencia ? referencia.cells.length : 0
        if (columnas < 2) return limpiar(tabla)
        const celdas = Array.from(referencia.cells)

        const restaurarScroll = guardarScroll(tabla)

        // 1. Ancho disponible y márgenes de los extremos, con la tabla como la deja su CSS.
        limpiar(tabla)
        const disponible = tabla.getBoundingClientRect().width
        const { bordeIzq, bordeDer } = rellenoDeLosExtremos(tabla, columnas)

        // 2. Ancho del contenido más ancho de cada columna: sin relleno ni anchos
        //    impuestos, cada columna mide lo que ocupa su celda más ancha.
        tabla.classList.add(CLASE_MIDIENDO)
        const anchos = celdas.map((celda) => Math.ceil(celda.getBoundingClientRect().width))
        tabla.classList.remove(CLASE_MIDIENDO)

        const contenido = anchos.reduce((a, b) => a + b, 0)
        const hueco = (disponible - contenido - bordeIzq - bordeDer) / (columnas - 1)
        if (hueco < HUECO_MINIMO) {
            restaurarScroll()
            return
        }

        // 3. El hueco se parte en dos: la mitad a la derecha de una columna y la otra
        //    mitad a la izquierda de la siguiente.
        const mitad = hueco / 2
        const izq = anchos.map((_, i) => (i === 0 ? bordeIzq : mitad))
        const der = anchos.map((_, i) => (i === columnas - 1 ? bordeDer : mitad))

        const grupo = colgroupPropio(tabla, columnas)
        if (!grupo) {
            restaurarScroll()
            return
        }
        tabla.classList.add(CLASE_ACTIVA)
        Array.from(grupo.children).forEach((col, i) => {
            col.style.width = anchos[i] + izq[i] + der[i] + "px"
        })
        // Con prioridad: hay celdas (.rowActionsCell, .tradingNumCell…) cuyo relleno
        // lleva !important en la hoja de estilos. Los extremos de la tabla no se tocan
        // y conservan el de su CSS (sangrías de filas de detalle incluidas).
        for (const fila of tabla.rows) {
            let inicio = 0
            for (const celda of fila.cells) {
                const fin = Math.min(inicio + (celda.colSpan || 1), columnas) - 1
                if (inicio > 0 && inicio < columnas) {
                    celda.style.setProperty("padding-left", izq[inicio] + "px", "important")
                }
                if (fin < columnas - 1) {
                    celda.style.setProperty("padding-right", der[fin] + "px", "important")
                }
                inicio = fin + 1
            }
        }
        restaurarScroll()
    }

    function procesar() {
        frame = 0
        const lista = Array.from(pendientes)
        pendientes.clear()
        lista.forEach(ajustar)
    }

    function programar(tabla) {
        pendientes.add(tabla)
        if (!frame) frame = requestAnimationFrame(procesar)
    }

    const alCambiarTamano = new ResizeObserver((entradas) => {
        for (const entrada of entradas) {
            const ancho = Math.round(entrada.contentRect.width)
            if (anchoObservado.get(entrada.target) === ancho) continue
            anchoObservado.set(entrada.target, ancho)
            programar(entrada.target)
        }
    })

    function registrar(tabla) {
        if (registradas.has(tabla)) return
        registradas.add(tabla)
        alCambiarTamano.observe(tabla)
        programar(tabla)
    }

    const alCambiarContenido = new MutationObserver((cambios) => {
        for (const cambio of cambios) {
            const nodo = cambio.target.nodeType === 1 ? cambio.target : cambio.target.parentElement
            const tabla = nodo && nodo.closest("table")
            if (tabla) {
                registrar(tabla)
                programar(tabla)
            }
            for (const anadido of cambio.addedNodes) {
                if (anadido.nodeType !== 1) continue
                if (anadido.tagName === "TABLE") registrar(anadido)
                else anadido.querySelectorAll("table").forEach(registrar)
            }
        }
    })

    function iniciar() {
        document.querySelectorAll("table").forEach(registrar)
        alCambiarContenido.observe(document.body, { childList: true, subtree: true, characterData: true })
        // Con la fuente definitiva los textos cambian de ancho.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => document.querySelectorAll("table").forEach(programar))
        }
    }

    if (document.body) iniciar()
    else document.addEventListener("DOMContentLoaded", iniciar)
})()
