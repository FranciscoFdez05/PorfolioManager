// Tooltips con estilo para toda la app.
//
// El atributo `title` saca la etiqueta nativa del navegador (fondo amarillo,
// sin tema). Aquí se intercepta: al pasar el ratón por cualquier elemento con
// `title` se mueve el texto a `data-tip` —para que el navegador ya no lo
// muestre— y se pinta en un único tooltip propio. Los módulos siguen poniendo
// `title` como siempre; si lo cambian después, el siguiente hover lo recoge.
;(function () {
    "use strict"

    const DELAY_MS = 250
    const GAP = 8
    const MARGIN = 6

    let tip = null
    let current = null
    let timer = null

    function ensureTip() {
        if (tip) return tip
        tip = document.createElement("div")
        tip.className = "appTooltip"
        tip.setAttribute("role", "tooltip")
        document.body.appendChild(tip)
        return tip
    }

    // Saca el title al data-tip. Si el elemento no tiene texto visible (botón
    // de icono), el title era su nombre accesible: se conserva como aria-label.
    function adopt(el) {
        const title = el.getAttribute("title")
        if (title == null) return
        el.removeAttribute("title")
        if (!title.trim()) return
        el.dataset.tip = title
        if (!el.hasAttribute("aria-label") && !el.textContent.trim()) {
            el.setAttribute("aria-label", title)
        }
    }

    function position(el) {
        const r = el.getBoundingClientRect()
        const t = ensureTip()
        t.classList.remove("appTooltipBelow")
        t.style.left = "0px"
        t.style.top = "0px"
        const w = t.offsetWidth
        const h = t.offsetHeight
        const vw = document.documentElement.clientWidth
        const vh = document.documentElement.clientHeight

        let top = r.top - h - GAP
        if (top < MARGIN) {
            top = Math.min(r.bottom + GAP, vh - h - MARGIN)
            t.classList.add("appTooltipBelow")
        }
        let left = r.left + r.width / 2 - w / 2
        left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN))

        t.style.left = Math.round(left) + "px"
        t.style.top = Math.round(top) + "px"
    }

    function show(el) {
        const label = el.dataset.tip
        if (!label || !el.isConnected) return
        const t = ensureTip()
        t.textContent = label
        position(el)
        t.classList.add("appTooltipVisible")
    }

    function hide() {
        clearTimeout(timer)
        timer = null
        current = null
        if (tip) tip.classList.remove("appTooltipVisible")
    }

    function target(node) {
        if (!node || !node.closest) return null
        return node.closest("[title], [data-tip]")
    }

    document.addEventListener(
        "mouseover",
        (e) => {
            const el = target(e.target)
            // Si el elemento se re-renderizó bajo el ratón no hubo mouseout.
            if (!el) {
                if (current && !current.isConnected) hide()
                return
            }
            // Los botones de acción de Activos tienen su propio tooltip.
            if (el.closest(".avActionBtn")) return
            adopt(el)
            if (el === current) return
            hide()
            if (!el.dataset.tip) return
            current = el
            timer = setTimeout(() => show(el), DELAY_MS)
        },
        true
    )

    document.addEventListener(
        "mouseout",
        (e) => {
            if (!current) return
            const to = e.relatedTarget
            if (to && current.contains(to)) return
            hide()
        },
        true
    )

    // Cualquier interacción o desplazamiento deja el tooltip fuera de sitio.
    document.addEventListener("mousedown", hide, true)
    document.addEventListener("keydown", hide, true)
    document.addEventListener("wheel", hide, { capture: true, passive: true })
    window.addEventListener("scroll", hide, true)
    window.addEventListener("blur", hide)
})()
