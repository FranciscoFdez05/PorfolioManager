// Las librerías del PDF (html2canvas y jsPDF) se descargan la primera vez que se
// exporta, no en cada carga de la página.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/informes.js")
})

let añadidos
let modo

beforeEach(() => {
    añadidos = []
    modo = "ok"
    delete globalThis.html2canvas
    delete window.jspdf
    // La promesa de la descarga es estado del módulo: cada test parte de cero.
    ;(0, eval)("infLibreriasPdf = null")
    vi.spyOn(document.head, "appendChild").mockImplementation((script) => {
        añadidos.push(script.src)
        queueMicrotask(() => {
            if (modo === "error") return script.onerror()
            if (script.src.includes("html2canvas")) globalThis.html2canvas = () => {}
            else window.jspdf = { jsPDF: function () {} }
            script.onload()
        })
        return script
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("infCargarLibreriasPdf", () => {
    it("descarga las dos librerías una sola vez aunque se pida dos veces a la vez", async () => {
        await Promise.all([infCargarLibreriasPdf(), infCargarLibreriasPdf()])
        await infCargarLibreriasPdf()

        expect(añadidos).toHaveLength(2)
        expect(añadidos.some((s) => s.includes("html2canvas-pro.min.js"))).toBe(true)
        expect(añadidos.some((s) => s.includes("jspdf.umd.min.js"))).toBe(true)
    })

    it("si falla una descarga lo propaga y el siguiente intento vuelve a probar", async () => {
        modo = "error"
        await expect(infCargarLibreriasPdf()).rejects.toThrow("No se pudo cargar")
        const intentos = añadidos.length

        modo = "ok"
        await infCargarLibreriasPdf()
        expect(añadidos.length).toBeGreaterThan(intentos)
    })
})

describe("infDescargarPdf sin librerías", () => {
    it("sigue lanzando el error de siempre si no se pudieron cargar", async () => {
        modo = "error"
        vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(infDescargarPdf("<p>x</p>", "informe")).rejects.toThrow("No se han cargado las librerías del PDF")
    })
})
