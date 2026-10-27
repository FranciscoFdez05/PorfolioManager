// Operaciones: control de conflictos con la revisión del servidor (auditoría, 12).
//
// Si otra pestaña guardó la lista entretanto, el guardado se rechaza con 409; la
// pestaña vuelve a pedir lo que hay, aplica encima lo que ella cambió y repite
// con la revisión nueva, en vez de borrar lo que añadió la otra.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const operacion = (id, estado = "Activo") => ({
    id,
    assetId: "ethereum",
    activo: "Ethereum",
    fechaApertura: "12-05-2025",
    par: "ETH/USDT",
    orden: "Compra",
    precioOrden: "2610",
    cantidad: "0,4",
    comisionesFiat: "2,10",
    total: "1044",
    estado,
    fechaCierre: "20-05-2025"
})

let peticiones
let respuestasPost
let filasDelServidor
let revisionDelServidor

function json(cuerpo, status = 200) {
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(cuerpo), text: () => Promise.resolve("") })
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/cripto/operaciones.js")
})

beforeEach(async () => {
    peticiones = []
    respuestasPost = []
    revisionDelServidor = 3
    filasDelServidor = [operacion("op-1")]
    localStorage.clear()
    globalThis.fetch = vi.fn((url, opciones) => {
        const ruta = String(url)
        if (opciones?.method === "POST") {
            peticiones.push(JSON.parse(opciones.body))
            return respuestasPost.shift() || json({ ok: true, revision: 99 })
        }
        if (ruta.startsWith("/api/operaciones")) {
            return json({ rows: filasDelServidor.map((fila) => ({ ...fila })), revision: revisionDelServidor })
        }
        if (ruta.startsWith("/api/activos")) return json({ assets: [] })
        return json({ ok: false }, 404)
    })
    globalThis.loadStablecoinsData = () => Promise.resolve({ catalog: [], enabledSymbols: [], rows: [] })
    globalThis.loadTransaccionesData = () => Promise.resolve({ rows: [] })
    const html = readFileSync(resolve(RAIZ, "html/cripto/operaciones.html"), "utf-8")
    document.body.innerHTML = `<div id="dynamicContent">${html}</div>`
    await initOperacionesLogic()
})

describe("operaciones con revisión", () => {
    it("manda la revisión que leyó y anota la que devuelve el servidor", async () => {
        respuestasPost.push(json({ ok: true, revision: 4 }))

        await persistOperationsData()
        await persistOperationsData()

        expect(peticiones[0].revision).toBe(3)
        expect(peticiones[1].revision).toBe(4)
    })

    it("ante un 409 conserva lo que añadió la otra pestaña y repite con la revisión nueva", async () => {
        // Mi pestaña cambia el estado de op-1; la otra añadió op-2 y avanzó la revisión.
        document.querySelector('tr[data-operation-id="op-1"] .operationsEstadoSelect').value = "Cancelado"
        document
            .querySelector('tr[data-operation-id="op-1"] .operationsEstadoSelect')
            .dispatchEvent(new Event("change", { bubbles: true }))
        filasDelServidor = [operacion("op-1"), operacion("op-2")]
        revisionDelServidor = 5
        respuestasPost.push(json({ ok: false, conflicto: true, revision: 5 }, 409))

        await vi.waitFor(() => expect(peticiones).toHaveLength(2))

        const reenviado = peticiones[1]
        expect(reenviado.revision).toBe(5)
        expect(reenviado.rows.map((fila) => `${fila.id}:${fila.estado}`).sort()).toEqual([
            "op-1:Cancelado",
            "op-2:Activo"
        ])
    })

    it("si las dos pestañas editaron la misma fila gana la guardada primero y el aviso es persistente", async () => {
        globalThis.showToast = vi.fn()
        document.querySelector('tr[data-operation-id="op-1"] .operationsEstadoSelect').value = "Cancelado"
        document
            .querySelector('tr[data-operation-id="op-1"] .operationsEstadoSelect')
            .dispatchEvent(new Event("change", { bubbles: true }))
        filasDelServidor = [operacion("op-1", "Completado")]
        revisionDelServidor = 5
        respuestasPost.push(json({ ok: false, conflicto: true, revision: 5 }, 409))

        await vi.waitFor(() => expect(peticiones).toHaveLength(2))

        const filas = peticiones[1].rows
        expect(filas.map((fila) => `${fila.id}:${fila.estado}`)).toEqual(["op-1:Completado"])
        expect(globalThis.showToast).toHaveBeenCalledTimes(1)
        expect(globalThis.showToast.mock.calls[0][1]).toMatchObject({ persistent: true })
    })

    it("si el reintento falla, la pestaña vuelve a lo guardado y no enseña datos sin guardar", async () => {
        globalThis.showToast = vi.fn()
        document.querySelector('tr[data-operation-id="op-1"] .operationsEstadoSelect').value = "Cancelado"
        filasDelServidor = [operacion("op-1"), operacion("op-2")]
        revisionDelServidor = 5
        respuestasPost.push(json({ ok: false, conflicto: true, revision: 5 }, 409))
        respuestasPost.push(json({ ok: false, error: "boom" }, 500))
        currentOperationsData.rows[0] = { ...currentOperationsData.rows[0], estado: "Cancelado" }

        await expect(persistOperationsData()).rejects.toThrow(/No se han guardado tus cambios/)

        expect(currentOperationsData.rows.map((fila) => `${fila.id}:${fila.estado}`)).toEqual([
            "op-1:Activo",
            "op-2:Activo"
        ])
    })

    it("con keepalive un 409 no se fusiona ni se reintenta", async () => {
        respuestasPost.push(json({ ok: false, conflicto: true, revision: 5 }, 409))

        await expect(persistOperationsData({ keepalive: true })).rejects.toThrow(/409/)

        expect(peticiones).toHaveLength(1)
    })
})
