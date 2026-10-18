// loadAssetData agrupa en una sola petición las fichas pedidas a la vez.
//
// Vista general, Métricas, Paneles... piden la ficha de cada activo con un
// Promise.all sobre la lista: eran 33 peticiones por pantalla. Ahora salen en
// un solo GET /api/activos-lote. Lo que tiene que seguir igual para quien
// llama: recibe la ficha que pidió, un activo que no existe sigue siendo un
// error, y dos llamadores del mismo activo no comparten el mismo objeto.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

const fichas = {
    apple: { id: "apple", name: "Apple", rows: [{ participaciones: "1" }] },
    tesla: { id: "tesla", name: "Tesla", rows: [] }
}

let urls

beforeEach(() => {
    urls = []
    window._viewAllPortfolios = false
    globalThis.fetch = vi.fn(async (url) => {
        urls.push(url)
        const ids = new URL(url, "http://x").searchParams.get("ids").split(",")
        const assets = Object.fromEntries(ids.filter((id) => fichas[id]).map((id) => [id, structuredClone(fichas[id])]))
        return new Response(JSON.stringify({ assets }), { status: 200 })
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("loadAssetData", () => {
    it("junta en una petición las fichas pedidas a la vez", async () => {
        const [a, t, otraA] = await Promise.all([
            loadAssetData("apple"),
            loadAssetData("tesla"),
            loadAssetData("apple")
        ])

        expect(urls).toEqual(["/api/activos-lote?ids=apple,tesla"])
        expect(a).toEqual(fichas.apple)
        expect(t).toEqual(fichas.tesla)
        expect(otraA).toEqual(fichas.apple)
        // Cada llamador tiene su copia.
        expect(otraA).not.toBe(a)
    })

    it("un activo que no existe sigue siendo un error para quien lo pidió", async () => {
        const [bien, mal] = await Promise.allSettled([loadAssetData("apple"), loadAssetData("no-existe")])

        expect(bien.status).toBe("fulfilled")
        expect(mal.status).toBe("rejected")
    })

    it("lo pedido después no reutiliza la respuesta anterior", async () => {
        await loadAssetData("apple")
        await loadAssetData("apple")

        expect(urls).toHaveLength(2)
    })
})
