// refreshAssetMarketDataOnServer: por defecto pide un precio nuevo; la carga y el
// refresco automáticos aceptan la caché del servidor (parámetro explícito).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

let urls
let cuerpos

beforeEach(() => {
    urls = []
    cuerpos = []
    globalThis.fetch = vi.fn(async (url, opciones) => {
        urls.push(url)
        cuerpos.push(opciones?.body ? JSON.parse(opciones.body) : null)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("refreshAssetMarketDataOnServer", () => {
    it("sin opciones no manda ningún parámetro (precio nuevo del proveedor)", async () => {
        await refreshAssetMarketDataOnServer("apple")

        expect(urls).toEqual(["/api/activos/apple/refresh-market-data"])
        expect(cuerpos).toEqual([null])
    })

    it("la carga automática manda usarCache", async () => {
        await refreshAssetMarketDataOnServer("apple", { usarCache: true })

        expect(urls).toEqual(["/api/activos/apple/refresh-market-data"])
        expect(cuerpos).toEqual([{ usarCache: true }])
    })

    it("el refresco automático manda además su intervalo como edad máxima", async () => {
        await refreshAssetMarketDataOnServer("apple", { usarCache: true, maxEdadSegundos: 300 })

        expect(urls).toEqual(["/api/activos/apple/refresh-market-data"])
        expect(cuerpos).toEqual([{ usarCache: true, maxEdadSegundos: 300 }])
    })

    it("la edad máxima sin usarCache se ignora", async () => {
        await refreshAssetMarketDataOnServer("apple", { maxEdadSegundos: 300 })

        expect(cuerpos).toEqual([null])
    })
})
