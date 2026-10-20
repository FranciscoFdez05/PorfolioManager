// Revisión y fusión en la ficha de activo y en Ventas.
//
// El servidor lleva una revisión por activo y por ejercicio de ventas y rechaza
// con 409 el guardado hecho sobre una copia antigua (stores/revisiones.py). El
// navegador, como en Gastos e Ingresos, vuelve a pedir lo que hay, aplica
// encima lo que el usuario cambió respecto a la copia que cargó y repite.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
    cargarScript("js/finanzas/ventas.js")
})

/** Respuesta JSON mínima. */
function json(cuerpo, status = 200) {
    return new Response(JSON.stringify(cuerpo), { status })
}

const fila = (fecha, participaciones) => ({ fechaOperacion: fecha, participaciones })

let peticiones

beforeEach(() => {
    peticiones = []
    window._viewAllPortfolios = false
    window._numLocale = "es-ES"
})

afterEach(() => {
    vi.restoreAllMocks()
})

/** fetch falso: las respuestas salen de `guion`, una por llamada en orden. */
function simularServidor(guion) {
    const pendientes = [...guion]
    globalThis.fetch = vi.fn(async (url, opciones = {}) => {
        peticiones.push({ url: String(url), metodo: opciones.method || "GET", cuerpo: opciones.body })
        const siguiente = pendientes.shift()
        if (!siguiente) throw new Error(`petición inesperada: ${url}`)
        return siguiente
    })
}

describe("la ficha de activo", () => {
    it("lee la revisión del lote y la reenvía al guardar, anotando la nueva", async () => {
        simularServidor([
            json({ assets: { apple: { id: "apple", rows: [fila("01-01-2026", "1")] } }, revisiones: { apple: 3 } }),
            json({ ok: true, revision: 4 })
        ])

        const ficha = await loadAssetData("apple")
        expect(ficha.revision).toBe(3)

        await saveAssetDataToServer(ficha)

        expect(JSON.parse(peticiones[1].cuerpo).revision).toBe(3)
        expect(ficha.revision).toBe(4)
    })

    it("ante un 409 fusiona lo cambiado con lo del servidor y repite con la revisión nueva", async () => {
        const original = fila("01-01-2026", "1")
        const deOtraPestana = fila("05-02-2026", "7")
        const mia = fila("10-03-2026", "2")
        simularServidor([
            // Lectura inicial: revisión 3.
            json({ assets: { apple: { id: "apple", rows: [original], price: "10,00" } }, revisiones: { apple: 3 } }),
            // El guardado choca.
            json({ ok: false, conflicto: true, revision: 5 }, 409),
            // Lo que hay ahora: otra pestaña añadió una fila y el precio cambió.
            json({
                assets: { apple: { id: "apple", rows: [original, deOtraPestana], price: "11,00" } },
                revisiones: { apple: 5 }
            }),
            json({ ok: true, revision: 6 })
        ])
        const eventos = []
        document.addEventListener("activo-guardado", (evento) => eventos.push(evento.detail))

        const ficha = await loadAssetData("apple")
        ficha.rows.push(mia)
        await saveAssetDataToServer(ficha)

        const reenviado = JSON.parse(peticiones[3].cuerpo)
        expect(reenviado.revision).toBe(5)
        expect(reenviado.rows).toEqual([original, deOtraPestana, mia])
        expect(reenviado.price).toBe("11,00")
        expect(eventos.at(-1).revision).toBe(6)
        expect(eventos.at(-1).fusionado.rows).toHaveLength(3)
    })

    it("lo que la otra pestaña borró y yo no toqué sigue borrado", async () => {
        const a = fila("01-01-2026", "1")
        const b = fila("02-01-2026", "2")
        simularServidor([
            json({ assets: { apple: { id: "apple", rows: [a, b] } }, revisiones: { apple: 1 } }),
            json({ ok: false, conflicto: true }, 409),
            json({ assets: { apple: { id: "apple", rows: [a] } }, revisiones: { apple: 2 } }),
            json({ ok: true, revision: 3 })
        ])

        const ficha = await loadAssetData("apple")
        ficha.color = "#123456"
        await saveAssetDataToServer(ficha)

        expect(JSON.parse(peticiones[3].cuerpo).rows).toEqual([a])
        expect(JSON.parse(peticiones[3].cuerpo).color).toBe("#123456")
    })

    it("un segundo 409 seguido es un error y no un bucle", async () => {
        simularServidor([
            json({ assets: { apple: { id: "apple", rows: [] } }, revisiones: { apple: 1 } }),
            json({ ok: false, conflicto: true }, 409),
            json({ assets: { apple: { id: "apple", rows: [] } }, revisiones: { apple: 2 } }),
            json({ ok: false, conflicto: true }, 409)
        ])

        const ficha = await loadAssetData("apple")

        await expect(saveAssetDataToServer(ficha)).rejects.toThrow(/409/)
        expect(peticiones).toHaveLength(4)
    })

    it("sin revisión conocida se guarda como siempre", async () => {
        simularServidor([json({ assets: { apple: { id: "apple", rows: [] } } }), json({ ok: true })])

        const ficha = await loadAssetData("apple")
        await saveAssetDataToServer(ficha)

        expect(ficha.revision).toBeUndefined()
        expect(JSON.parse(peticiones[1].cuerpo).revision).toBeUndefined()
    })
})

describe("Ventas", () => {
    const venta = (id, cantidad = "1") => ({
        id,
        fecha: "10-02-2026",
        assetId: "apple",
        cantidad,
        valorVenta: "10",
        comisionVenta: ""
    })

    beforeEach(() => {
        globalThis.refreshAssetsSidebar = vi.fn(async () => {})
        applyVentasPayload({ year: "2026", rows: [venta("v1")], revision: 4 })
    })

    it("manda la revisión que leyó", async () => {
        simularServidor([json({ ok: true, year: "2026", rows: [venta("v1")], revision: 5 })])

        await persistVentasData()

        expect(JSON.parse(peticiones[0].cuerpo).revision).toBe(4)
    })

    it("ante un 409 conserva la venta que entró desde otro sitio", async () => {
        applyVentasPayload({ year: "2026", rows: [venta("v1")], revision: 4 })
        currentVentasData.rows.push(venta("v2", "3"))
        simularServidor([
            json({ ok: false, conflicto: true, revision: 6 }, 409),
            json({ year: "2026", rows: [venta("v1"), venta("v9", "5")], revision: 6 }),
            json({ ok: true, year: "2026", rows: [venta("v1"), venta("v9", "5"), venta("v2", "3")], revision: 7 })
        ])

        await persistVentasData()

        const reenviado = JSON.parse(peticiones[2].cuerpo)
        expect(reenviado.revision).toBe(6)
        expect(reenviado.rows.map((r) => r.id)).toEqual(["v1", "v9", "v2"])
        expect(currentVentasData.revision).toBe(7)
    })

    it("con keepalive un 409 no se fusiona: no hay tiempo y no se ha borrado nada", async () => {
        simularServidor([json({ ok: false, conflicto: true }, 409)])

        await expect(persistVentasData({ keepalive: true })).rejects.toThrow()
        expect(peticiones).toHaveLength(1)
    })

    it("lo que se teclea en el modal se guarda en canónico, no con el formato de pantalla", () => {
        window._numLocale = "es-ES"
        expect(toCanonicalNumber("12.000")).toBe("12.000") // un punto es decimal: 12 unidades
        expect(toCanonicalNumber("12000")).toBe("12000")
        expect(toCanonicalNumber("1.234,5")).toBe("1234.5")
        expect(formatVentasNumberInput("12000")).toBe("12000")
        expect(formatVentasNumberInput("1234,5")).toBe("1234,5")
    })
})
