// Pruebas de js/core/cache-paginas.js: el HTML de cada ventana se pide una
// sola vez por pestaña, los fallos no se quedan guardados y la precarga
// descarga de una en una lo que falta.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

let fetchFalso

beforeEach(() => {
    vi.useFakeTimers()
    // Sin requestIdleCallback el módulo cae a setTimeout, que se controla aquí.
    delete window.requestIdleCallback
    fetchFalso = vi.fn((url) => Promise.resolve(new Response(`<div>${url}</div>`)))
    window.fetch = fetchFalso
    cargarScript("js/core/cache-paginas.js")
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("obtener", () => {
    it("descarga el fragmento una sola vez", async () => {
        const a = await window.CachePaginas.obtener("./html/a.html?v=1")
        const b = await window.CachePaginas.obtener("./html/a.html?v=1")

        expect(a).toBe("<div>./html/a.html?v=1</div>")
        expect(b).toBe(a)
        expect(fetchFalso).toHaveBeenCalledTimes(1)
    })

    it("un error HTTP se propaga y no se guarda", async () => {
        fetchFalso.mockImplementationOnce(() => Promise.resolve(new Response("", { status: 404 })))

        await expect(window.CachePaginas.obtener("./html/x.html")).rejects.toThrow("HTTP 404")
        await expect(window.CachePaginas.obtener("./html/x.html")).resolves.toContain("x.html")
        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })
})

describe("precargar", () => {
    it("descarga de una en una lo que aún no está en memoria", async () => {
        await window.CachePaginas.obtener("./html/a.html")
        window.CachePaginas.precargar(["./html/a.html", "./html/b.html", "./html/c.html"])

        expect(fetchFalso).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1000)
        expect(fetchFalso).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(1000)
        expect(fetchFalso).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(5000)
        expect(fetchFalso).toHaveBeenCalledTimes(3)

        await window.CachePaginas.obtener("./html/c.html")
        expect(fetchFalso).toHaveBeenCalledTimes(3)
    })

    it("un fallo en la precarga no corta las siguientes", async () => {
        fetchFalso.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
        window.CachePaginas.precargar(["./html/a.html", "./html/b.html"])

        await vi.advanceTimersByTimeAsync(2000)
        expect(fetchFalso.mock.calls.map(([url]) => url)).toEqual(["./html/a.html", "./html/b.html"])
    })
})
