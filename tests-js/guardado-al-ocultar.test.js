// Operaciones no debe volver a guardar su lista entera al ocultar la pestaña si
// no se ha cambiado nada: una pestaña con la lista vieja pisaba lo guardado
// desde otro sitio (auditoría B-14).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const OPERACION = {
    id: "op-eth-1",
    assetId: "ethereum",
    activo: "Ethereum",
    fechaApertura: "12-05-2025",
    par: "ETH/USDT",
    orden: "Compra",
    precioOrden: "2610",
    cantidad: "0,4",
    comisionesFiat: "2,10",
    total: "1044",
    estado: "Activo",
    fechaCierre: "20-05-2025"
}

let guardados = []

function respuesta(cuerpo) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(cuerpo) })
}

function ocultarPestana() {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/operaciones.js")
})

beforeEach(async () => {
    guardados = []
    localStorage.clear()
    globalThis.fetch = vi.fn((url, opciones) => {
        if (opciones?.method === "POST") {
            guardados.push(JSON.parse(opciones.body))
            return respuesta({ ok: true })
        }
        if (String(url).startsWith("/api/operaciones")) return respuesta({ rows: [{ ...OPERACION }] })
        if (String(url).startsWith("/api/activos")) return respuesta({ assets: [] })
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
    })
    globalThis.loadStablecoinsData = () => Promise.resolve({ catalog: [], enabledSymbols: [], rows: [] })
    globalThis.loadTransaccionesData = () => Promise.resolve({ rows: [] })
    const html = readFileSync(resolve(RAIZ, "html/cripto/operaciones.html"), "utf-8")
    document.body.innerHTML = `<div id="dynamicContent">${html}</div>`
    await initOperacionesLogic()
})

describe("guardado al ocultar la pestaña", () => {
    it("no guarda nada si no se ha editado", async () => {
        ocultarPestana()
        await new Promise((resolver) => setTimeout(resolver, 20))

        expect(guardados).toHaveLength(0)
    })

    it("guarda lo editado una sola vez y no repite al ocultar de nuevo", async () => {
        const select = document.querySelector('tr[data-operation-id="op-eth-1"] .operationsEstadoSelect')
        select.value = "Cancelado"
        select.dispatchEvent(new Event("change", { bubbles: true }))
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        ocultarPestana()
        await new Promise((resolver) => setTimeout(resolver, 20))

        expect(guardados).toHaveLength(1)
    })
})
