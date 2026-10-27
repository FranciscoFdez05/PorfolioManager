// Generar el PDF tardaba ~10 s con la página congelada y sin decir nada: el
// botón vive en un menú ··· que se cierra al pulsarlo. Ahora un aviso dice por
// qué hoja va, el botón queda deshabilitado mientras dura (y no se puede lanzar
// dos veces) y entre hoja y hoja se devuelve el control al navegador. Ante un
// error, el aviso se cierra y el botón vuelve a estar disponible.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/informes.js")
})

// Alto de una hoja en px del contenedor: 267 mm útiles con 190 mm de ancho
// repartidos en 718 px. Cinco hojas y media dan seis páginas.
const ANCHO_PX = 718
const ALTO_HOJA_PX = 267 / (190 / ANCHO_PX)
const ALTO_TOTAL_PX = Math.round(ALTO_HOJA_PX * 5.5)

let documentos
let alAñadirImagen
let boton

class PdfFalso {
    constructor() {
        this.paginas = 1
        this.imagenes = 0
        this.guardado = null
        documentos.push(this)
    }
    setProperties() {}
    addPage() {
        this.paginas++
    }
    addImage() {
        this.imagenes++
        alAñadirImagen?.(this.imagenes)
    }
    setFontSize() {}
    setTextColor() {}
    text() {}
    save(nombre) {
        this.guardado = nombre
    }
}

beforeEach(() => {
    documentos = []
    alAñadirImagen = null
    globalThis.html2canvas = vi.fn(async () => ({ width: ANCHO_PX * 2, height: ALTO_TOTAL_PX * 2 }))
    window.jspdf = { jsPDF: PdfFalso }
    // jsdom no maqueta ni dibuja: se le dan las medidas y un contexto de lienzo.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(ANCHO_PX)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(ALTO_TOTAL_PX)
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {}, drawImage() {} })
    vi.spyOn(window, "alert").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    document.body.innerHTML = '<button id="informeBtn" type="button">Descargar informe (PDF)</button>'
    boton = document.getElementById("informeBtn")
})

afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ""
})

const avisoVisible = () => document.querySelector(".appToast")?.textContent ?? null
const generarInforme = () => infGenerar(boton, (alProgresar) => infDescargarPdf("<p>x</p>", "informe", alProgresar))

describe("infDescargarPdf", () => {
    it("avisa del progreso hoja a hoja, en orden y con el total", async () => {
        const progreso = []
        await infDescargarPdf("<p>x</p>", "informe", (texto) => progreso.push(texto))

        const paginas = progreso.filter((t) => /página \d/.test(t))
        expect(paginas).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Generando informe… página ${n} de 6`))
        expect(progreso[0]).toContain("preparando")
        expect(documentos[0].paginas).toBe(6)
        expect(documentos[0].guardado).toBe("informe.pdf")
    })

    it("devuelve el control al navegador entre hoja y hoja", async () => {
        // Un temporizador puesto al empezar solo puede colarse antes del final
        // si el bucle cede el hilo; en un forEach síncrono llegaría tarde.
        let cedido = false
        alAñadirImagen = (n) => {
            if (n === 1) setTimeout(() => (cedido = true), 0)
            if (n === 6) expect(cedido).toBe(true)
        }
        await infDescargarPdf("<p>x</p>", "informe")
        expect(documentos[0].imagenes).toBe(6)
    })

    it("mantiene la escala de siempre en html2canvas para no perder nitidez", async () => {
        await infDescargarPdf("<p>x</p>", "informe")
        expect(globalThis.html2canvas).toHaveBeenCalledWith(
            expect.any(HTMLElement),
            expect.objectContaining({ scale: 2 })
        )
    })

    it("sigue funcionando sin nadie escuchando el progreso", async () => {
        await expect(infDescargarPdf("<p>x</p>", "informe")).resolves.toBeUndefined()
        expect(documentos[0].paginas).toBe(6)
    })
})

describe("infGenerar", () => {
    it("deshabilita el botón y enseña la página en curso mientras genera", async () => {
        const vistos = []
        alAñadirImagen = () => vistos.push({ aviso: avisoVisible(), deshabilitado: boton.disabled })

        await generarInforme()

        expect(vistos.map((v) => v.aviso)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Generando informe… página ${n} de 6`))
        expect(vistos.every((v) => v.deshabilitado)).toBe(true)
    })

    it("al acabar cierra el aviso y deja el botón como estaba", async () => {
        await generarInforme()

        expect(avisoVisible()).toBeNull()
        expect(boton.disabled).toBe(false)
        expect(boton.textContent).toBe("Descargar informe (PDF)")
        expect(boton.dataset.generando).toBeUndefined()
    })

    it("no lanza un segundo informe mientras el primero sigue en marcha", async () => {
        const generar = vi.fn((alProgresar) => infDescargarPdf("<p>x</p>", "informe", alProgresar))

        await Promise.all([infGenerar(boton, generar), infGenerar(boton, generar)])

        expect(generar).toHaveBeenCalledTimes(1)
        expect(documentos).toHaveLength(1)
    })

    it("ante un error cierra el aviso, rehabilita el botón y lo dice", async () => {
        globalThis.html2canvas = vi.fn(async () => {
            throw new Error("lienzo demasiado grande")
        })

        await generarInforme()

        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("No se pudo generar el informe"))
        expect(avisoVisible()).toBeNull()
        expect(boton.disabled).toBe(false)
        expect(boton.textContent).toBe("Descargar informe (PDF)")
        expect(document.getElementById("informeImprimible")).toBeNull()
    })
})
