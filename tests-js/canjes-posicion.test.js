// La cartera del navegador tiene que mover los títulos de un canje igual que el
// servidor (stores/rendimiento_activo.py): salen del activo entregado y entran
// en el recibido con el coste y la fecha de adquisición de cada lote, así que
// una venta posterior consume primero los heredados más antiguos.
import { beforeAll, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

const POSICION = [
    { canjeId: "c1", assetId: "tsla", fecha: "01-06-2026", tipo: "Venta", cantidad: "20", coste: "0",
      moneda: "EUR", fechaAntiguedad: "", descuento: "0", monedaDescuento: "EUR" },
    { canjeId: "c1", assetId: "spacex", fecha: "01-06-2026", tipo: "Compra", cantidad: "20", coste: "1000",
      moneda: "EUR", fechaAntiguedad: "01-01-2020", descuento: "50", monedaDescuento: "EUR" },
    { canjeId: "c1", assetId: "spacex", fecha: "01-06-2026", tipo: "Compra", cantidad: "20", coste: "2000",
      moneda: "EUR", fechaAntiguedad: "01-01-2022", descuento: "50", monedaDescuento: "EUR" }
]

function compra(fecha, participaciones, precio) {
    return { fechaOperacion: fecha, tipoOperacion: "Compra", participaciones, precioParticipacion: precio }
}

async function cargarCanjes(posicion) {
    globalThis.fetch = vi.fn(async (url) => {
        const cuerpo = String(url).startsWith("/api/canjes") ? { rows: [], posicion } : { rows: [], rate: 1 }
        return new Response(JSON.stringify(cuerpo), { status: 200 })
    })
    await loadVentasRowsForAssets()
    await loadTransaccionesRowsForAssets()
    setExternalOperacionesRowsForAssets([])
}

describe("canjes de valores en la posición del navegador", () => {
    it("vacía el activo entregado", async () => {
        await cargarCanjes(POSICION)
        const tsla = { id: "tsla", type: "accion", currency: "EUR",
            rows: [compra("01-01-2020", "10", "100"), compra("01-01-2022", "10", "200")] }

        const lotes = await buildRemainingAssetLots(tsla, "EUR")

        expect(lotes.reduce((total, lote) => total + lote.remaining, 0)).toBe(0)
    })

    it("da al recibido los lotes heredados con la compensación descontada", async () => {
        await cargarCanjes(POSICION)
        const spacex = { id: "spacex", type: "accion", currency: "EUR", rows: [] }

        const lotes = await buildRemainingAssetLots(spacex, "EUR")

        expect(lotes.map((lote) => lote.remaining)).toEqual([20, 20])
        expect(lotes.map((lote) => lote.totalCost)).toEqual([950, 1950])
    })

    it("consume primero los heredados más antiguos que lo que ya había", async () => {
        await cargarCanjes(POSICION)
        const spacex = {
            id: "spacex", type: "accion", currency: "EUR",
            rows: [
                compra("01-03-2025", "10", "500"),
                { fechaOperacion: "01-09-2026", tipoOperacion: "Venta", participaciones: "25" }
            ]
        }

        const lotes = (await buildRemainingAssetLots(spacex, "EUR")).filter((lote) => lote.remaining > 0)

        // 20 del lote de 2020 y 5 del de 2022: queda la compra propia de 2025
        // entera y 15 del lote de 2022.
        expect(lotes.map((lote) => [lote.origen, lote.remaining])).toEqual([
            ["canje", 15],
            ["spot", 10]
        ])
    })

    it("sigue cargando las ventas si /api/canjes falla", async () => {
        globalThis.fetch = vi.fn(async (url) =>
            String(url).startsWith("/api/canjes")
                ? new Response("{}", { status: 500 })
                : new Response(JSON.stringify({ rows: [{ assetId: "x", fecha: "01-01-2026", cantidad: "1" }] }), {
                      status: 200
                  })
        )
        vi.spyOn(console, "error").mockImplementation(() => {})

        const ventas = await loadVentasRowsForAssets()

        expect(ventas).toHaveLength(1)
        expect(getAssetCanjesRows({ id: "spacex" })).toEqual([])
    })
})
