// Refresco de cotizaciones al abrir la aplicación.
//
// Se pedían una tras otra: con 33 activos y ~200 ms por proveedor eran ~7 s
// antes de que la interfaz dejase de cargar. Ahora van varias a la vez, con un
// tope para no acaparar las conexiones del navegador. Lo que no puede cambiar:
// se piden todas, cada una una sola vez, y un fallo se sigue apuntando para que
// el sidebar lo marque.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

const activos = Array.from({ length: 10 }, (_, i) => ({
    id: `activo-${i}`,
    name: `Activo ${i}`,
    symbol: `A${i}`,
    marketSymbol: `A${i}`,
    type: "acciones"
}))

let enCurso
let maximoEnCurso
let pedidas

function respuesta(cuerpo, estado = 200) {
    return Promise.resolve(new Response(JSON.stringify(cuerpo), { status: estado }))
}

beforeEach(() => {
    enCurso = 0
    maximoEnCurso = 0
    pedidas = []
    _falloApiPorActivo.clear()
    window._viewAllPortfolios = false
    globalThis.refreshAssetsSidebar = vi.fn()
    globalThis.renderVistaGeneralTable = vi.fn()
    globalThis.fetch = vi.fn(async (url) => {
        if (url === "/api/activos") return respuesta({ assets: activos })
        const m = String(url).match(/^\/api\/activos\/([^/]+)\/refresh-market-data$/)
        if (!m) return respuesta({})
        pedidas.push(m[1])
        enCurso++
        maximoEnCurso = Math.max(maximoEnCurso, enCurso)
        await new Promise((r) => setTimeout(r, 5))
        enCurso--
        return m[1] === "activo-3" ? respuesta({ ok: false, error: "límite" }, 503) : respuesta({ ok: true })
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("refreshOverviewMarketData", () => {
    it("pide cada cotización una vez, varias a la vez y nunca más de 4", async () => {
        await refreshOverviewMarketData()

        expect([...pedidas].sort()).toEqual(activos.map((a) => a.id).sort())
        expect(maximoEnCurso).toBeGreaterThan(1)
        expect(maximoEnCurso).toBeLessThanOrEqual(4)
    })

    it("apunta el fallo de un activo sin cortar el resto", async () => {
        await refreshOverviewMarketData()

        expect(_falloApiPorActivo.has("activo-3")).toBe(true)
        expect(_falloApiPorActivo.size).toBe(1)
        expect(globalThis.renderVistaGeneralTable).toHaveBeenCalled()
    })
})
