// Pruebas del reparto de huecos entre columnas (js/core/tablas.js).
//
// jsdom no hace layout, así que las medidas se simulan: cada celda dice su
// ancho en data-w y solo lo da mientras su tabla está en modo "midiendo". Lo
// que se comprueba es el reparto: que el hueco sobrante se divide por igual y
// qué tablas se dejan sin tocar.
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

let colaFrames = []
let tablasOcultas = new WeakSet()

beforeAll(() => {
    window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    window.requestAnimationFrame = (cb) => {
        colaFrames.push(cb)
        return colaFrames.length
    }
    Element.prototype.getClientRects = function () {
        return tablasOcultas.has(this) ? [] : [{}]
    }
    Element.prototype.getBoundingClientRect = function () {
        const tabla = this.closest?.("table")
        if (this.tagName === "TABLE") return { width: 600, left: 0, top: 0, right: 600, bottom: 0, height: 0 }
        const midiendo = tabla?.classList.contains("tablaMidiendo")
        return { width: midiendo ? Number(this.dataset.w || 0) : 0, left: 0, top: 0, right: 0, bottom: 0, height: 0 }
    }
    const estilo = document.createElement("style")
    estilo.textContent = "td, th { padding: 0 }"
    document.head.appendChild(estilo)
    cargarScript("js/core/tablas.js")
})

afterEach(async () => {
    document.body.innerHTML = ""
    // Deja correr el frame que haya quedado pendiente: tablas.js solo programa
    // uno a la vez y, si se descarta, no vuelve a programar ninguno.
    await procesarFrames()
    colaFrames = []
    tablasOcultas = new WeakSet()
})

function crearTabla(anchos) {
    const tabla = document.createElement("table")
    const cabecera = tabla.createTHead().insertRow()
    const cuerpo = tabla.createTBody()
    anchos.forEach((ancho) => {
        const th = document.createElement("th")
        th.dataset.w = String(ancho)
        cabecera.appendChild(th)
    })
    for (let i = 0; i < 2; i++) {
        const fila = cuerpo.insertRow()
        anchos.forEach((ancho) => {
            const td = fila.insertCell()
            td.dataset.w = String(ancho)
        })
    }
    return tabla
}

async function procesarFrames() {
    // El MutationObserver avisa en un microtask y programa el frame.
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const cola = colaFrames
    colaFrames = []
    cola.forEach((cb) => cb())
}

const anchosDeColumnas = (tabla) => [...tabla.querySelectorAll(":scope > colgroup > col")].map((c) => c.style.width)

describe("tablas.js", () => {
    it("reparte el hueco sobrante por igual entre columnas", async () => {
        const tabla = crearTabla([100, 50, 50])
        document.body.appendChild(tabla)
        await procesarFrames()
        // 600 de ancho - 200 de contenido = 400 de hueco, 200 por cada unión.
        expect(tabla.classList.contains("tablaHuecosIguales")).toBe(true)
        expect(anchosDeColumnas(tabla)).toEqual(["200px", "250px", "150px"])
        expect(tabla.rows[1].cells[1].style.getPropertyValue("padding-left")).toBe("100px")
        expect(tabla.rows[1].cells[0].style.getPropertyValue("padding-right")).toBe("100px")
    })

    it("deja como estaba una tabla que no cabe ni con las cabeceras partidas", async () => {
        const tabla = crearTabla([300, 200, 200])
        document.body.appendChild(tabla)
        await procesarFrames()
        expect(tabla.classList.contains("tablaHuecosIguales")).toBe(false)
        expect(tabla.classList.contains("tablaMidiendo")).toBe(false)
    })

    it("ignora las tablas ocultas y las de una sola columna", async () => {
        const oculta = crearTabla([100, 50, 50])
        tablasOcultas.add(oculta)
        const una = crearTabla([100])
        document.body.append(oculta, una)
        await procesarFrames()
        expect(oculta.classList.contains("tablaHuecosIguales")).toBe(false)
        expect(una.classList.contains("tablaHuecosIguales")).toBe(false)
    })

    it("no toca las excluidas (calendario)", async () => {
        const tabla = crearTabla([100, 50, 50])
        tabla.classList.add("calendarioTable")
        document.body.appendChild(tabla)
        await procesarFrames()
        expect(tabla.classList.contains("tablaHuecosIguales")).toBe(false)
    })

    it("vuelve a repartir cuando cambia el contenido", async () => {
        const tabla = crearTabla([100, 50, 50])
        document.body.appendChild(tabla)
        await procesarFrames()
        expect(anchosDeColumnas(tabla)).toEqual(["200px", "250px", "150px"])
        tabla.querySelectorAll("[data-w]").forEach((celda) => (celda.dataset.w = "100"))
        tabla.tBodies[0].appendChild(tabla.tBodies[0].rows[0].cloneNode(true))
        await procesarFrames()
        // 600 - 300 = 300 de hueco, 150 por cada unión (75 a cada lado).
        expect(anchosDeColumnas(tabla)).toEqual(["175px", "250px", "175px"])
    })
})
