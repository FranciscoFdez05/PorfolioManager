// Operaciones no debe alterar campos de filas que nadie ha editado al guardar
// (auditoría A): la divisa y la stablecoin se recalculaban desde el par al
// cargar y, con un par ilegible, la divisa pasaba a USD.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const FILAS = [
    {
        id: "ejemplo3-1",
        assetId: "ethereum",
        activo: "Ethereum",
        fechaApertura: "12-05-2025",
        par: "14-01-2015",
        stablecoinSymbol: "",
        orden: "Compra",
        precioOrden: "2610",
        precioCurrency: "EUR",
        cantidad: "0,4",
        comisionesCripto: "",
        comisionesFiat: "2,10",
        total: "1044",
        currency: "EUR",
        estado: "Completado",
        fechaCierre: "20-05-2025"
    },
    {
        id: "normal-1",
        assetId: "ethereum",
        activo: "Ethereum",
        fechaApertura: "13-05-2025",
        par: "ETH/USDT",
        stablecoinSymbol: "",
        orden: "Compra",
        precioOrden: "2600",
        precioCurrency: "EUR",
        cantidad: "1",
        comisionesCripto: "",
        comisionesFiat: "",
        total: "2600",
        currency: "EUR",
        estado: "Activo",
        fechaCierre: ""
    }
]

let enviados

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/cripto/operaciones.js")
})

beforeEach(async () => {
    enviados = []
    localStorage.clear()
    globalThis.fetch = vi.fn((url, opciones) => {
        const ok = (cuerpo) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(cuerpo) })
        if (opciones?.method === "POST") {
            enviados.push(JSON.parse(opciones.body))
            return ok({ ok: true, revision: 2 })
        }
        if (String(url).startsWith("/api/operaciones")) return ok({ rows: FILAS.map((f) => ({ ...f })), revision: 1 })
        if (String(url).startsWith("/api/activos")) {
            return ok({ assets: [{ id: "ethereum", name: "Ethereum", symbol: "ETH", type: "cripto", price: "2400" }] })
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    })
    globalThis.loadStablecoinsData = () =>
        Promise.resolve({ catalog: [{ symbol: "USDT" }], enabledSymbols: ["USDT"], rows: [] })
    globalThis.loadTransaccionesData = () => Promise.resolve({ rows: [] })
    const html = readFileSync(resolve(RAIZ, "html/cripto/operaciones.html"), "utf-8")
    document.body.innerHTML = `<div id="dynamicContent">${html}</div>`
    await initOperacionesLogic()
})

describe("guardar sin editar", () => {
    it("manda las filas tal como estaban guardadas, divisa y stablecoin incluidas", async () => {
        await persistOperationsData()

        const mandadas = Object.fromEntries(enviados[0].rows.map((fila) => [fila.id, fila]))
        for (const original of FILAS) {
            const fila = mandadas[original.id]
            expect(fila.currency).toBe(original.currency)
            expect(fila.precioCurrency).toBe(original.precioCurrency)
            expect(fila.stablecoinSymbol).toBe(original.stablecoinSymbol)
            expect(fila.par).toBe(original.par)
        }
    })

    it("cambiar solo el estado de una fila con par ilegible conserva su divisa", async () => {
        const fila = currentOperationsData.rows.find((item) => item.id === "ejemplo3-1")
        const cambiada = normalizeOperationRow({ ...fila, estado: "Cancelado" }, 0, true)

        expect(cambiada.currency).toBe("EUR")
        expect(cambiada.precioCurrency).toBe("EUR")
    })
})
