// Escala de la interfaz en pantallas grandes.
//
// La maqueta está hecha en px pensando en un monitor de 24" (1920×1080). En uno
// de 27" a 2560 o en un 4K sin escalado del sistema todo sale diminuto, así que
// responsive.css pone `zoom` en <html> a partir de cierto tamaño (variable
// --ui-zoom, solo con la clase uiZoom que añade el script en línea de
// index.html si el navegador tiene el zoom estándar).
//
// Con el zoom estándar (Chrome 128+, Firefox 126+) getBoundingClientRect, las
// coordenadas del ratón e innerWidth vienen en px de pantalla, mientras que
// offsetWidth, clientWidth y los px que se escriben en style.left/top son px de
// la página. Toda la app (menús, tooltips, popups, arrastrar paneles…) mezcla
// unos y otros dando por hecho que son lo mismo, como lo eran sin zoom. En vez
// de corregir cada sitio, aquí se devuelven esas medidas en px de la página
// mientras hay zoom: con zoom 1 todo queda exactamente como estaba.
;(function () {
    "use strict"

    const html = document.documentElement
    if (!html.classList.contains("uiZoom")) return

    // El zoom de <html> del documento del elemento (html2canvas clona la página
    // en un iframe, que tiene el suyo).
    function zoomDe(doc) {
        return (doc && doc.documentElement && doc.documentElement.currentCSSZoom) || 1
    }
    function zoom() {
        return html.currentCSSZoom || 1
    }

    function escalar(rect, z) {
        if (z === 1) return rect
        return new DOMRect(rect.x / z, rect.y / z, rect.width / z, rect.height / z)
    }

    function envolverRect(proto) {
        const original = proto.getBoundingClientRect
        proto.getBoundingClientRect = function () {
            const doc = this.ownerDocument || (this.startContainer && this.startContainer.ownerDocument)
            return escalar(original.call(this), zoomDe(doc || document))
        }
    }
    envolverRect(Element.prototype)
    envolverRect(Range.prototype)

    function envolverGetter(proto, prop, factor) {
        const desc = Object.getOwnPropertyDescriptor(proto, prop)
        if (!desc || !desc.get) return
        Object.defineProperty(proto, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
                return desc.get.call(this) / factor(this)
            }
        })
    }

    for (const prop of ["clientX", "clientY", "pageX", "pageY", "x", "y"]) {
        envolverGetter(MouseEvent.prototype, prop, zoom)
    }
    if (typeof Touch !== "undefined") {
        for (const prop of ["clientX", "clientY", "pageX", "pageY"]) {
            envolverGetter(Touch.prototype, prop, zoom)
        }
    }

    // innerWidth/innerHeight son propios de window, no del prototipo.
    for (const prop of ["innerWidth", "innerHeight"]) {
        const desc = Object.getOwnPropertyDescriptor(window, prop)
        if (!desc || !desc.get) continue
        Object.defineProperty(window, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
                return desc.get.call(window) / zoom()
            }
        })
    }

    // Px de pantalla por px de la página: los <canvas> (Chart.js) se dibujan a
    // esa resolución y no salen borrosos al ampliarse.
    const dpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")
    if (dpr && dpr.get) {
        Object.defineProperty(window, "devicePixelRatio", {
            configurable: true,
            enumerable: dpr.enumerable,
            get() {
                return dpr.get.call(window) * zoom()
            }
        })
    }

    for (const metodo of ["elementFromPoint", "elementsFromPoint"]) {
        const original = Document.prototype[metodo]
        if (!original) continue
        Document.prototype[metodo] = function (x, y) {
            const z = zoomDe(this)
            return original.call(this, x * z, y * z)
        }
    }
})()
