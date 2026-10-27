// Los avisos persistentes (algo no se ha guardado) se agrupan en uno, no se
// duplican, tienen botón de cierre y se cierran al cambiar de pantalla.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
})

beforeEach(() => {
    closePersistentToasts()
    document.body.innerHTML = ""
})

describe("avisos persistentes", () => {
    it("varios avisos distintos salen en un solo cuadro con una línea cada uno", () => {
        showToast("Operaciones no guardadas", { type: "error", persistent: true })
        showToast("Trades no guardados", { type: "warning", persistent: true })

        expect(document.querySelectorAll(".appToast")).toHaveLength(1)
        expect([...document.querySelectorAll(".appToast p")].map((p) => p.textContent)).toEqual([
            "Operaciones no guardadas",
            "Trades no guardados"
        ])
    })

    it("el mismo aviso no se repite", () => {
        showToast("Operaciones no guardadas", { type: "error", persistent: true })
        showToast("Operaciones no guardadas", { type: "error", persistent: true })

        expect(document.querySelectorAll(".appToast p")).toHaveLength(1)
    })

    it("tiene un botón que lo cierra", () => {
        showToast("Operaciones no guardadas", { type: "error", persistent: true })

        document.querySelector(".appToastClose").click()

        expect(document.querySelectorAll(".appToast")).toHaveLength(0)
    })

    it("se cierra con closePersistentToasts, que usa el cambio de pantalla", () => {
        showToast("Operaciones no guardadas", { type: "error", persistent: true })

        closePersistentToasts()

        expect(document.querySelectorAll(".appToast")).toHaveLength(0)
    })

    it("los avisos normales siguen siendo independientes y se van solos", () => {
        showToast("Guardado", { type: "success" })
        showToast("Otro", { type: "success" })

        expect(document.querySelectorAll(".appToast")).toHaveLength(2)
    })
})
