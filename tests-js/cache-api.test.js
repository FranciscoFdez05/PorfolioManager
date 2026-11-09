// Pruebas de js/core/cache-api.js.
//
// Lo que no puede fallar nunca es servir un dato viejo después de una
// escritura: por eso la mayoría de casos son de invalidación. El resto cubre
// que la caché ahorra peticiones donde debe y solo ahí.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

let fetchFalso

/** Response real (Node la trae) para que funcionen arrayBuffer() y headers. */
function respuesta(cuerpo, { status = 200, headers = {} } = {}) {
    return new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status, headers })
}

/** Promesa que se resuelve a mano, para simular peticiones en vuelo. */
function diferida() {
    let resolver
    const promesa = new Promise((r) => (resolver = r))
    return { promesa, resolver }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fetchFalso = vi.fn((url) => Promise.resolve(respuesta({ url, n: fetchFalso.mock.calls.length })))
    window.fetch = fetchFalso
    cargarScript("js/core/cache-api.js")
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("lecturas cacheables", () => {
    it("la segunda lectura igual sale de memoria con el mismo contenido", async () => {
        const primera = await (await window.fetch("/api/activos")).json()
        const segunda = await (await window.fetch("/api/activos")).json()

        expect(fetchFalso).toHaveBeenCalledTimes(1)
        expect(segunda).toEqual(primera)
    })

    it("cada acierto devuelve una Response nueva que se puede leer", async () => {
        await window.fetch("/api/cuentas")
        const a = await window.fetch("/api/cuentas")
        const b = await window.fetch("/api/cuentas")

        expect(a).not.toBe(b)
        await a.text()
        await expect(b.json()).resolves.toMatchObject({ url: "/api/cuentas" })
    })

    it("distingue la query string", async () => {
        await window.fetch("/api/portfolio/history?range=1D")
        await window.fetch("/api/portfolio/history?range=ALL")

        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("junta dos lecturas iguales que están en vuelo", async () => {
        const pendiente = diferida()
        fetchFalso.mockImplementationOnce(() => pendiente.promesa)

        const a = window.fetch("/api/activos-lote?ids=bitcoin")
        const b = window.fetch("/api/activos-lote?ids=bitcoin")
        pendiente.resolver(respuesta({ ok: 1 }))

        await expect((await a).json()).resolves.toEqual({ ok: 1 })
        await expect((await b).json()).resolves.toEqual({ ok: 1 })
        expect(fetchFalso).toHaveBeenCalledTimes(1)
    })

    it("caduca pasado el TTL", async () => {
        await window.fetch("/api/activos")
        vi.setSystemTime(Date.now() + window.CacheApi.TTL_MS + 1)
        await window.fetch("/api/activos")

        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })
})

describe("lo que no se cachea", () => {
    it.each([
        "/api/market/pulse",
        "/api/actualizacion/estado",
        "/api/wallets",
        "/api/settings/2fa",
        "/api/activos/bitcoin",
        "/html/finanzas/gastos.html",
        "https://otro.example/api/activos"
    ])("%s va siempre al servidor", async (url) => {
        await window.fetch(url)
        await window.fetch(url)

        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("respeta cache: no-store en la llamada", async () => {
        await window.fetch("/api/activos")
        await window.fetch("/api/activos", { cache: "no-store" })

        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("no guarda respuestas con Cache-Control: no-store", async () => {
        fetchFalso.mockImplementation(() =>
            Promise.resolve(respuesta("{}", { headers: { "Cache-Control": "no-store" } }))
        )
        await window.fetch("/api/settings")
        await window.fetch("/api/settings")

        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("no guarda errores y devuelve el original a quien la pidió", async () => {
        fetchFalso.mockImplementationOnce(() => Promise.resolve(respuesta('{"error":"x"}', { status: 500 })))

        const fallo = await window.fetch("/api/activos")
        expect(fallo.status).toBe(500)
        await expect(fallo.json()).resolves.toEqual({ error: "x" })

        const bien = await window.fetch("/api/activos")
        expect(bien.status).toBe(200)
        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("no guarda un fallo de red", async () => {
        fetchFalso.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))

        await expect(window.fetch("/api/activos")).rejects.toThrow("Failed to fetch")
        await window.fetch("/api/activos")
        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("quien se engancha a una lectura que acaba en error la repite por su cuenta", async () => {
        const pendiente = diferida()
        fetchFalso.mockImplementationOnce(() => pendiente.promesa)

        const a = window.fetch("/api/activos")
        const b = window.fetch("/api/activos")
        pendiente.resolver(respuesta("{}", { status: 503 }))

        expect((await a).status).toBe(503)
        expect((await b).status).toBe(200)
        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })
})

describe("invalidación por escrituras", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])("un %s vacía la caché", async (method) => {
        await window.fetch("/api/activos")
        await window.fetch("/api/cuentas/42", { method })
        await window.fetch("/api/activos")

        expect(fetchFalso.mock.calls.filter(([url]) => url === "/api/activos")).toHaveLength(2)
    })

    it("una lectura que cruza una escritura no se guarda", async () => {
        const lectura = diferida()
        const escritura = diferida()
        fetchFalso.mockImplementationOnce(() => lectura.promesa).mockImplementationOnce(() => escritura.promesa)

        const vieja = window.fetch("/api/operaciones")
        const guardado = window.fetch("/api/operaciones", { method: "POST" })
        lectura.resolver(respuesta({ version: "antes" }))
        await vieja
        escritura.resolver(respuesta("{}"))
        await guardado

        const nueva = await (await window.fetch("/api/operaciones")).json()
        expect(nueva).not.toEqual({ version: "antes" })
        expect(fetchFalso).toHaveBeenCalledTimes(3)
    })

    it("una lectura lanzada durante la escritura tampoco se reutiliza después", async () => {
        const escritura = diferida()
        fetchFalso.mockImplementationOnce(() => escritura.promesa)

        const guardado = window.fetch("/api/gastos/2026", { method: "POST" })
        await window.fetch("/api/gastos/2026")
        escritura.resolver(respuesta("{}"))
        await guardado
        await window.fetch("/api/gastos/2026")

        expect(fetchFalso.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2)
    })

    it("una escritura fallida también vacía la caché", async () => {
        await window.fetch("/api/activos")
        fetchFalso.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
        await expect(window.fetch("/api/activos", { method: "POST" })).rejects.toThrow()
        await window.fetch("/api/activos")

        expect(fetchFalso).toHaveBeenCalledTimes(3)
    })
})

describe("cancelación", () => {
    it("abortar una llamada no cancela la lectura compartida", async () => {
        const pendiente = diferida()
        fetchFalso.mockImplementationOnce(() => pendiente.promesa)
        const controlador = new AbortController()

        const abortada = window.fetch("/api/activos", { signal: controlador.signal })
        const otra = window.fetch("/api/activos")
        controlador.abort()
        pendiente.resolver(respuesta({ ok: 1 }))

        await expect(abortada).rejects.toMatchObject({ name: "AbortError" })
        await expect((await otra).json()).resolves.toEqual({ ok: 1 })
        expect(fetchFalso.mock.calls[0][1]?.signal).toBeUndefined()
    })

    it("una señal ya abortada rechaza sin esperar", async () => {
        const controlador = new AbortController()
        controlador.abort()

        await expect(window.fetch("/api/activos", { signal: controlador.signal })).rejects.toMatchObject({
            name: "AbortError"
        })
    })
})
