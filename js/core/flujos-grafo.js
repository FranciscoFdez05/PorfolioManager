// ===== GRAFO DE FLUJOS =====
// Ventana con una bolita por cuenta (o wallet) y una flecha por cada pareja
// origen → destino, más gruesa cuanto más dinero ha pasado por ella. Cada
// bolita dice lo que ha entrado y lo que ha salido. La usan Cuentas (euros) y
// Transacciones cripto (unidades de la moneda); cada página prepara sus
// movimientos y este módulo solo los agrega y los dibuja.
//
//   abrirGrafoFlujos({
//       titulo, subtitulo,
//       movimientos: [{ origen, destino, cantidad }],  // origen/destino = etiqueta
//       formato: (n) => "1.234,00 €",
//       vacio: "No hay movimientos."
//   })

const GRAFO_ANCHO = 720
const GRAFO_ALTO = 520

function grafoAgregar(movimientos) {
    const nodos = new Map()
    const enlaces = new Map()
    const nodo = (nombre) => {
        if (!nodos.has(nombre)) nodos.set(nombre, { nombre, entra: 0, sale: 0 })
        return nodos.get(nombre)
    }
    movimientos.forEach(({ origen, destino, cantidad }) => {
        const valor = Number(cantidad)
        if (!origen || !destino || origen === destino || !Number.isFinite(valor) || valor <= 0) return
        nodo(origen).sale += valor
        nodo(destino).entra += valor
        const clave = `${origen}\u0000${destino}`
        const enlace = enlaces.get(clave) || { origen, destino, total: 0, veces: 0 }
        enlace.total += valor
        enlace.veces += 1
        enlaces.set(clave, enlace)
    })
    return { nodos: [...nodos.values()], enlaces: [...enlaces.values()] }
}

// Bolitas en círculo, la de más volumen arriba y el resto en orden descendente:
// con las pocas cuentas que tiene una persona se leen todas sin cruzarse.
function grafoColocar(nodos) {
    const cx = GRAFO_ANCHO / 2
    const cy = GRAFO_ALTO / 2
    const maxVolumen = Math.max(...nodos.map((n) => n.entra + n.sale), 1)
    const ordenados = [...nodos].sort((a, b) => b.entra + b.sale - (a.entra + a.sale))
    const radioCirculo = nodos.length <= 1 ? 0 : Math.min(cx - 120, cy - 95)
    ordenados.forEach((n, i) => {
        const angulo = -Math.PI / 2 + (2 * Math.PI * i) / ordenados.length
        n.x = cx + radioCirculo * Math.cos(angulo)
        n.y = cy + radioCirculo * Math.sin(angulo)
        n.r = 16 + 22 * Math.sqrt((n.entra + n.sale) / maxVolumen)
    })
    return ordenados
}

// Curva de `a` a `b` que acaba en el borde de la bolita de destino. Se dobla
// siempre hacia la izquierda del sentido de la marcha, así que A→B y B→A salen
// como dos arcos separados en vez de taparse.
function grafoCamino(a, b, grosor) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const largo = Math.hypot(dx, dy) || 1
    const ux = dx / largo
    const uy = dy / largo
    const curva = Math.min(60, largo * 0.18)
    const mx = (a.x + b.x) / 2 - uy * curva
    const my = (a.y + b.y) / 2 + ux * curva
    const salida = grafoBorde(a, mx, my, a.r + 2)
    const llegada = grafoBorde(b, mx, my, b.r + 4 + grosor)
    return `M${salida.x.toFixed(1)},${salida.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${llegada.x.toFixed(1)},${llegada.y.toFixed(1)}`
}

function grafoBorde(centro, haciaX, haciaY, distancia) {
    const dx = haciaX - centro.x
    const dy = haciaY - centro.y
    const largo = Math.hypot(dx, dy) || 1
    return { x: centro.x + (dx / largo) * distancia, y: centro.y + (dy / largo) * distancia }
}

function cerrarGrafoFlujos() {
    document.getElementById("grafoFlujosOverlay")?.remove()
    document.removeEventListener("keydown", grafoTeclas)
}

function grafoTeclas(event) {
    if (event.key === "Escape") cerrarGrafoFlujos()
}

function abrirGrafoFlujos({ titulo, subtitulo = "", movimientos = [], formato = (n) => String(n), vacio = "" }) {
    cerrarGrafoFlujos()
    const { nodos, enlaces } = grafoAgregar(movimientos)
    const colocados = grafoColocar(nodos)
    const porNombre = new Map(colocados.map((n) => [n.nombre, n]))
    const maxEnlace = Math.max(...enlaces.map((e) => e.total), 1)
    const grosor = (e) => 1.5 + 8.5 * Math.sqrt(e.total / maxEnlace)

    const flechas = [...enlaces]
        .sort((a, b) => b.total - a.total)
        .map((e, i) => {
            const g = grosor(e)
            const tip = `${e.origen} → ${e.destino}: ${formato(e.total)} · ${e.veces} movimiento${e.veces === 1 ? "" : "s"}`
            return `
                <g class="grafoEnlace" data-origen="${escapeHtml(e.origen)}" data-destino="${escapeHtml(e.destino)}" title="${escapeHtml(tip)}">
                    <path class="grafoEnlaceZona" d="${grafoCamino(porNombre.get(e.origen), porNombre.get(e.destino), g)}"></path>
                    <path class="grafoEnlaceLinea" d="${grafoCamino(porNombre.get(e.origen), porNombre.get(e.destino), g)}" stroke-width="${g.toFixed(1)}" marker-end="url(#grafoFlecha${i})"></path>
                    <marker id="grafoFlecha${i}" class="grafoFlecha" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="3" markerHeight="3" markerUnits="strokeWidth" orient="auto">
                        <path d="M0,0 L10,5 L0,10 z"></path>
                    </marker>
                </g>`
        })
        .join("")

    const bolitas = colocados
        .map((n) => {
            const abajo = n.y >= GRAFO_ALTO / 2 - 1
            // Las etiquetas van por fuera del círculo para no pisar las flechas.
            const yTexto = abajo ? n.y + n.r + 16 : n.y - n.r - 40
            const tip = `${n.nombre} · entra ${formato(n.entra)} · sale ${formato(n.sale)}`
            return `
                <g class="grafoNodo" data-nodo="${escapeHtml(n.nombre)}" tabindex="0" title="${escapeHtml(tip)}">
                    <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}"></circle>
                    <text class="grafoNodoNombre" x="${n.x.toFixed(1)}" y="${yTexto.toFixed(1)}">${escapeHtml(grafoRecortar(n.nombre))}</text>
                    <text class="grafoNodoEntra" x="${n.x.toFixed(1)}" y="${(yTexto + 14).toFixed(1)}">+${escapeHtml(formato(n.entra))}</text>
                    <text class="grafoNodoSale" x="${n.x.toFixed(1)}" y="${(yTexto + 27).toFixed(1)}">−${escapeHtml(formato(n.sale))}</text>
                </g>`
        })
        .join("")

    const filasTabla = [...enlaces]
        .sort((a, b) => b.total - a.total)
        .map(
            (e) => `
                <tr data-origen="${escapeHtml(e.origen)}" data-destino="${escapeHtml(e.destino)}">
                    <td>${escapeHtml(e.origen)}</td>
                    <td>${escapeHtml(e.destino)}</td>
                    <td class="numCell">${e.veces}</td>
                    <td class="numCell">${escapeHtml(formato(e.total))}</td>
                </tr>`
        )
        .join("")

    const overlay = document.createElement("div")
    overlay.id = "grafoFlujosOverlay"
    overlay.className = "modalOverlay"
    overlay.innerHTML = `
        <div class="assetModal grafoFlujosModal" role="dialog" aria-modal="true" aria-labelledby="grafoFlujosTitulo">
            <div class="grafoFlujosCab">
                <div>
                    <h3 class="assetModalTitle" id="grafoFlujosTitulo">${escapeHtml(titulo)}</h3>
                    ${subtitulo ? `<p class="grafoFlujosSub">${escapeHtml(subtitulo)}</p>` : ""}
                </div>
                <button type="button" class="cancelButton" data-grafo-cerrar>Cerrar</button>
            </div>
            ${
                enlaces.length
                    ? `
            <p class="grafoFlujosLeyenda">
                <span><i class="grafoMuestra grafoMuestraEntra"></i>Entrante</span>
                <span><i class="grafoMuestra grafoMuestraSale"></i>Saliente</span>
                <span class="grafoFlujosPista">Pasa el ratón o pulsa una bolita para ver solo sus movimientos. El grosor de la flecha es el importe.</span>
            </p>
            <svg class="grafoFlujosSvg" viewBox="0 0 ${GRAFO_ANCHO} ${GRAFO_ALTO}" role="img" aria-label="${escapeHtml(titulo)}">
                <g class="grafoEnlaces">${flechas}</g>
                <g class="grafoNodos">${bolitas}</g>
            </svg>
            <details class="grafoFlujosTabla">
                <summary>Ver como tabla</summary>
                <table class="gastosMovementsTable">
                    <thead><tr><th>Origen</th><th>Destino</th><th class="numCol">Movimientos</th><th class="numCol">Total</th></tr></thead>
                    <tbody>${filasTabla}</tbody>
                </table>
            </details>`
                    : `<p class="overviewEmpty">${escapeHtml(vacio || "No hay movimientos que dibujar.")}</p>`
            }
        </div>`

    const svg = overlay.querySelector(".grafoFlujosSvg")
    let fijado = ""
    const resaltar = (nombre) => {
        if (!svg) return
        svg.classList.toggle("grafoEnfocado", Boolean(nombre))
        svg.querySelectorAll(".grafoNodo").forEach((g) => {
            const enlazado =
                g.dataset.nodo === nombre ||
                enlaces.some(
                    (e) =>
                        (e.origen === nombre && e.destino === g.dataset.nodo) ||
                        (e.destino === nombre && e.origen === g.dataset.nodo)
                )
            g.classList.toggle("activo", g.dataset.nodo === nombre)
            g.classList.toggle("vecino", Boolean(nombre) && enlazado)
        })
        svg.querySelectorAll(".grafoEnlace").forEach((g) => {
            g.classList.toggle("entra", Boolean(nombre) && g.dataset.destino === nombre)
            g.classList.toggle("sale", Boolean(nombre) && g.dataset.origen === nombre)
        })
    }

    svg?.addEventListener("pointerover", (event) => {
        const g = event.target.closest(".grafoNodo")
        if (g && !fijado) resaltar(g.dataset.nodo)
    })
    svg?.addEventListener("pointerout", (event) => {
        const g = event.target.closest(".grafoNodo")
        if (g && !g.contains(event.relatedTarget) && !fijado) resaltar("")
    })
    svg?.addEventListener("click", (event) => {
        const g = event.target.closest(".grafoNodo")
        fijado = g && g.dataset.nodo !== fijado ? g.dataset.nodo : ""
        resaltar(fijado)
    })
    svg?.addEventListener("keydown", (event) => {
        const g = event.target.closest(".grafoNodo")
        if (!g || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        fijado = g.dataset.nodo !== fijado ? g.dataset.nodo : ""
        resaltar(fijado)
    })

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-grafo-cerrar]")) cerrarGrafoFlujos()
    })
    document.addEventListener("keydown", grafoTeclas)
    document.body.appendChild(overlay)
}

function grafoRecortar(texto) {
    const limpio = String(texto)
    return limpio.length > 22 ? `${limpio.slice(0, 8)}…${limpio.slice(-6)}` : limpio
}
