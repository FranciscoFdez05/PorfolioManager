// Pruebas de que las tiras con scroll lateral no dejan listeners en window al
// salir de la página (js/core/app-core.js).
//
// Cada visita a una página vuelve a ejecutar su inicialización sobre nodos
// nuevos. Un listener puesto en document o window que no se retira retiene el
// DOM entero de la visita, y los clics y scrolls se vuelven más lentos cuanto
// más se navega.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
})

afterEach(() => {
    document.body.innerHTML = ""
    vi.restoreAllMocks()
})

describe("initScrollLateral", () => {
    const claves = { scrollable: "a", inicio: "b", fin: "c", arrastrando: "d" }

    it("registra un solo listener de resize por muchas tiras que se monten", () => {
        const espia = vi.spyOn(window, "addEventListener")
        for (let i = 0; i < 20; i++) {
            const tira = document.createElement("div")
            document.body.appendChild(tira)
            window.initScrollLateral(tira, claves)
        }
        const resizes = espia.mock.calls.filter(([tipo]) => tipo === "resize")
        expect(resizes.length).toBeLessThanOrEqual(1)
    })

    it("recalcula las tiras conectadas al redimensionar y se olvida de las retiradas", () => {
        const viva = document.createElement("div")
        const muerta = document.createElement("div")
        document.body.append(viva, muerta)
        const espiaViva = vi.spyOn(viva.classList, "toggle")
        const espiaMuerta = vi.spyOn(muerta.classList, "toggle")
        window.initScrollLateral(viva, claves)
        window.initScrollLateral(muerta, claves)
        espiaViva.mockClear()
        espiaMuerta.mockClear()
        muerta.remove()
        window.dispatchEvent(new Event("resize"))
        expect(espiaViva).toHaveBeenCalled()
        expect(espiaMuerta).not.toHaveBeenCalled()
    })

    it("devuelve una funcion vacia si no hay elemento", () => {
        expect(window.initScrollLateral(null, claves)).toBeTypeOf("function")
    })
})
