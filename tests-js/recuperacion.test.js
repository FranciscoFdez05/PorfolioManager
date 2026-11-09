// Pruebas de js/core/recuperacion.js: aviso de errores no capturados sin
// inundar la pantalla, y reapertura de la vista solo cuando el servidor vuelve
// tras una caída real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

let avisos
let fetchFalso

beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<section id="dynamicContent"></section>'
    avisos = []
    window.showToast = vi.fn((mensaje, opciones) => {
        const nodo = document.createElement("div")
        document.body.appendChild(nodo)
        avisos.push({ mensaje, opciones, nodo })
        return nodo
    })
    fetchFalso = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
    window.fetch = fetchFalso
    window.loadPage = vi.fn(() => Promise.resolve())
    window._paginaActual = "cuentas"
    vi.spyOn(console, "error").mockImplementation(() => {})
    cargarScript("js/core/recuperacion.js")
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

function pintarErrorDeCarga() {
    document.getElementById("dynamicContent").innerHTML = '<div class="pageError">Error de carga</div>'
}

describe("errores no capturados", () => {
    it("avisa una vez aunque el mismo fallo se repita en bucle", () => {
        for (let i = 0; i < 5; i++) window.Recuperacion.alFallar(new Error("boom"))

        expect(avisos).toHaveLength(1)
        expect(avisos[0].opciones.type).toBe("error")
    })

    it("vuelve a avisar pasado el margen", () => {
        window.Recuperacion.alFallar(new Error("uno"))
        vi.advanceTimersByTime(10001)
        window.Recuperacion.alFallar(new Error("dos"))

        expect(avisos).toHaveLength(2)
    })

    it("ignora las cancelaciones y el ruido del navegador", () => {
        const cancelada = new Error("cancelada")
        cancelada.name = "AbortError"
        window.Recuperacion.alFallar(cancelada)
        window.Recuperacion.alFallar("ResizeObserver loop completed with undelivered notifications.")
        window.Recuperacion.alFallar("Script error.")

        expect(avisos).toHaveLength(0)
    })

    it("un fallo de red no da aviso de error sino que espera al servidor", async () => {
        window.Recuperacion.alFallar({ isNetwork: true, message: "Failed to fetch" })
        await vi.runOnlyPendingTimersAsync()

        expect(avisos.some((a) => a.opciones.type === "error")).toBe(false)
        expect(fetchFalso).toHaveBeenCalledWith("/api/health", expect.objectContaining({ cache: "no-store" }))
    })
})

describe("vuelta del servidor", () => {
    it("reabre la vista que falló cuando el servidor vuelve", async () => {
        pintarErrorDeCarga()
        fetchFalso
            .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
            .mockImplementationOnce(() => Promise.resolve(new Response("", { status: 503 })))

        const espera = window.Recuperacion.esperarServidor()
        await vi.runAllTimersAsync()
        await espera

        expect(fetchFalso).toHaveBeenCalledTimes(3)
        expect(window.loadPage).toHaveBeenCalledWith("cuentas")
        expect(avisos.map((a) => a.mensaje)).toContain("Conexión recuperada.")
        // El aviso de «sin conexión» se retira al volver.
        expect(avisos[0].nodo.parentNode).toBeNull()
    })

    it("no reabre la vista si el servidor nunca estuvo caído", async () => {
        pintarErrorDeCarga()

        await window.Recuperacion.esperarServidor()

        expect(window.loadPage).not.toHaveBeenCalled()
        expect(avisos).toHaveLength(0)
    })

    it("un solo bucle de espera aunque fallen muchas peticiones", async () => {
        fetchFalso.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")))

        window.Recuperacion.esperarServidor()
        window.Recuperacion.esperarServidor()
        window.Recuperacion.esperarServidor()
        await vi.advanceTimersByTimeAsync(0)

        expect(fetchFalso).toHaveBeenCalledTimes(1)
    })

    it("la espera entre sondas crece hasta un máximo", async () => {
        fetchFalso.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")))

        window.Recuperacion.esperarServidor()
        await vi.advanceTimersByTimeAsync(0)
        // 2 + 4 + 8 + 16 s: cuatro reintentos más.
        await vi.advanceTimersByTimeAsync(30000)

        expect(fetchFalso).toHaveBeenCalledTimes(5)
    })

    it("al aparecer un «Error de carga» comprueba el servidor", async () => {
        pintarErrorDeCarga()
        await vi.advanceTimersByTimeAsync(0)

        expect(fetchFalso).toHaveBeenCalledWith("/api/health", expect.anything())
    })
})
