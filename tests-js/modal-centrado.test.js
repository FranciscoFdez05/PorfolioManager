// Dónde se centra el diálogo de confirmar.
//
// El diálogo no se centra en la ventana a propósito: se alinea con
// `#dynamicContent` para caer sobre el contenido con el que estás trabajando, y
// no sobre la barra lateral. Eso está bien en la aplicación, y está mal en
// cuanto se abre Ajustes: ese panel ocupa la pantalla entera con su propia
// barra y sus dos columnas, así que `#dynamicContent` queda **detrás** y el
// diálogo aparecía desplazado a la izquierda respecto a lo único que se ve.
//
// Las tres situaciones tienen que quedar fijadas juntas, porque el arreglo de
// una es exactamente lo que rompe la otra.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/cartera/assets.js")
})

// jsdom no hace layout: `getBoundingClientRect` devuelve ceros y la función se
// rendiría por «rectángulo vacío» antes de llegar a lo que se quiere probar.
function montarDom({ ajustesAbierto, conAjustes = true }) {
    document.body.innerHTML = `
        <div class="modalOverlay" id="confirmModalOverlay"></div>
        <div id="dynamicContent"></div>
        ${conAjustes ? `<div id="sttOverlay" class="${ajustesAbierto ? "" : "hidden"}"></div>` : ""}
    `

    // Contenido desplazado a la derecha por la barra lateral de la aplicación,
    // que es el caso en el que este alineado tiene sentido.
    document.getElementById("dynamicContent").getBoundingClientRect = () => ({
        top: 60,
        right: 1024,
        bottom: 768,
        left: 220,
        width: 804,
        height: 708
    })

    return document.getElementById("confirmModalOverlay")
}

describe("alignConfirmModalToContent", () => {
    beforeEach(() => {
        document.body.innerHTML = ""
    })

    it("se alinea con el contenido cuando Ajustes está cerrado", () => {
        const overlay = montarDom({ ajustesAbierto: false })

        alignConfirmModalToContent()

        // El hueco de la izquierda es el de la barra lateral: el diálogo cae
        // sobre el contenido, no sobre ella.
        expect(overlay.style.paddingLeft).toBe("220px")
        expect(overlay.style.paddingTop).toBe("60px")
    })

    it("se centra en la ventana cuando Ajustes está abierto", () => {
        const overlay = montarDom({ ajustesAbierto: true })

        alignConfirmModalToContent()

        // Sin padding, el `justify-content: center` del overlay lo deja en el
        // centro de la pantalla, que es el único marco visible entonces.
        expect(overlay.style.padding).toBe("")
    })

    it("en una página sin panel de Ajustes se comporta como siempre", () => {
        const overlay = montarDom({ ajustesAbierto: false, conAjustes: false })

        alignConfirmModalToContent()

        expect(overlay.style.paddingLeft).toBe("220px")
    })

    it("no toca nada si el diálogo está oculto", () => {
        const overlay = montarDom({ ajustesAbierto: true })
        overlay.classList.add("hidden")
        overlay.style.padding = "5px"

        alignConfirmModalToContent()

        expect(overlay.style.padding).toBe("5px")
    })
})
