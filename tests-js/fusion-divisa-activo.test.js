// Tras un 409 la ficha toma del servidor la divisa junto al precio (auditoría
// B-26): si otra pestaña convirtió el activo, el precio nuevo ya viene en la
// divisa nueva y conservar la local lo dejaba con una etiqueta falsa.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

function json(cuerpo, status = 200) {
    return new Response(JSON.stringify(cuerpo), { status })
}

let peticiones

beforeEach(() => {
    peticiones = []
    window._viewAllPortfolios = false
    window._numLocale = "es-ES"
})

afterEach(() => {
    vi.restoreAllMocks()
})

function simularServidor(guion) {
    const pendientes = [...guion]
    globalThis.fetch = vi.fn(async (url, opciones = {}) => {
        peticiones.push({ url: String(url), metodo: opciones.method || "GET", cuerpo: opciones.body })
        const siguiente = pendientes.shift()
        if (!siguiente) throw new Error(`petición inesperada: ${url}`)
        return siguiente
    })
}

describe("fusión de la ficha tras un 409", () => {
    it("toma la divisa del servidor junto con el precio", async () => {
        simularServidor([
            json({ assets: { apple: { id: "apple", rows: [], price: "10,00", currency: "USD" } }, revisiones: { apple: 3 } }),
            json({ ok: false, conflicto: true, revision: 4 }, 409),
            json({ assets: { apple: { id: "apple", rows: [], price: "9,20", currency: "EUR" } }, revisiones: { apple: 4 } }),
            json({ ok: true, revision: 5 })
        ])

        const ficha = await loadAssetData("apple")
        await saveAssetDataToServer(ficha)

        const reenviado = JSON.parse(peticiones[3].cuerpo)
        expect(reenviado.price).toBe("9,20")
        expect(reenviado.currency).toBe("EUR")
    })

    it("rechaza la fusión si hay filas nuevas tecleadas en otra divisa", async () => {
        const base = { id: "apple", rows: [], price: "10,00", currency: "USD" }
        simularServidor([
            json({ assets: { apple: base }, revisiones: { apple: 3 } }),
            json({ ok: false, conflicto: true, revision: 4 }, 409),
            json({ assets: { apple: { ...base, price: "9,20", currency: "EUR" } }, revisiones: { apple: 4 } })
        ])

        const ficha = await loadAssetData("apple")
        ficha.rows.push({ fechaOperacion: "01-02-2026", participaciones: "1", capitalInvertidoBruto: "100" })

        await expect(saveAssetDataToServer(ficha)).rejects.toThrow(/cambiado de divisa/)
        // Nada de repetir el guardado con las filas en la divisa equivocada.
        expect(peticiones).toHaveLength(3)
    })

    it("tras fusionar, la ficha abierta repinta la cabecera con el precio y la divisa del servidor", () => {
        document.body.innerHTML = `
            <section class="assetTablePage" data-asset-id="apple" data-asset-price="150,00" data-asset-currency="USD">
                <table><tbody id="assetOperationsBody"></tbody></table>
            </section>`
        currentAssetId = "apple"
        globalThis.renderAssetRows = vi.fn()
        globalThis.refreshAssetHeaderStats = vi.fn()
        const fusionado = { id: "apple", rows: [], price: "138,00", currency: "EUR", operationRows: [], conversionRows: [] }

        document.dispatchEvent(new CustomEvent("activo-guardado", { detail: { id: "apple", revision: 5, fusionado } }))

        const pagina = document.querySelector(".assetTablePage")
        expect(pagina.dataset.assetPrice).toBe("138,00")
        expect(pagina.dataset.assetCurrency).toBe("EUR")
        expect(globalThis.refreshAssetHeaderStats).toHaveBeenCalledWith(fusionado)
    })
})
