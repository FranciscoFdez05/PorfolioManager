// Editar un activo: qué se guarda y qué no se toca.
//
// Este fichero nace de un fallo que no daba ninguna pista: cambiar el color de
// un activo respondía «No se pudo actualizar el nombre del activo». El guardado
// sí llegaba al servidor; lo que reventaba era la línea siguiente, un
// `editAssetModalState = null` contra una variable que había quedado declarada
// `const` en js/core/app-core.js. Con `const`, una asignación entre módulos no
// falla al cargar la página: falla al ejecutarse, y el `catch` de turno la
// convierte en un mensaje que habla de otra cosa.
//
// Lo que se cubre, entonces, es lo que no se ve mirando un fichero solo:
//
//   1. **Las globales de página son escribibles.** Las declara app-core.js y las
//      asigna assets.js, así que el linter no puede comprobarlo.
//   2. **La edición no pierde nada.** Guardar reescribe el activo entero, y el
//      modal solo edita cuatro campos: las compras y las conversiones tienen que
//      viajar intactas aunque la tabla no esté en pantalla.
//   3. **El aviso dice la verdad.** Si el guardado falla, el mensaje habla de la
//      edición y repite lo que respondió el servidor.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    // El orden es el de index.html.
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/cartera/assets.js")
})

/** El activo tal y como lo devuelve GET /api/activos/<id>. */
const ACTIVO = {
    id: "xrp",
    name: "XRP",
    symbol: "XRP",
    marketProvider: "finnhub",
    marketSymbol: "BINANCE:XRPEUR",
    finnhubSymbol: "BINANCE:XRPEUR",
    type: "cripto",
    order: 3,
    price: "1,15",
    currency: "EUR",
    change: "-1,77%",
    status: "Cotización actualizada",
    lastUpdated: "2026-09-02T19:05:25",
    color: "#000000",
    tvSymbol: "BITVAVO:XRPEUR",
    hidden: false,
    rows: [
        { fechaOperacion: "01-01-2026", participaciones: "10", precioParticipacion: "1,00" },
        { fechaOperacion: "01-02-2026", participaciones: "5", precioParticipacion: "1,20" }
    ],
    operationRows: [{ id: "op1", activo: "XRP" }],
    conversionRows: [{ id: "cv1" }]
}

let peticiones = []

/** Deja el modal de edición en pantalla con los valores que se van a guardar. */
function montarModal({ nombre = "XRP", color = "#242222", ticker = "BINANCE:XRPEUR" } = {}) {
    document.body.innerHTML = `
        <div id="editAssetModalOverlay"></div>
        <input id="editAssetNameInput" value="${nombre}">
        <input id="editAssetTickerInput" value="${ticker}">
        <input id="editAssetColorInput" value="${color}">
        <input id="editAssetTVTickerInput" value="BITVAVO:XRPEUR">
        <div id="editAssetSearchFeedback"></div>
        <div id="editAssetSearchResults"></div>
    `
}

/** La respuesta del servidor a cada petición, según el método. */
function servidor({ guardarFalla = null } = {}) {
    return vi.fn(async (url, init) => {
        const method = (init?.method || "GET").toUpperCase()
        peticiones.push({ url, method, body: init?.body ? JSON.parse(init.body) : null })

        if (method === "POST" && guardarFalla) {
            return {
                ok: false,
                status: guardarFalla.status,
                text: async () => JSON.stringify({ ok: false, error: guardarFalla.error })
            }
        }

        // El GET siempre devuelve el activo tal y como está guardado: es de donde
        // sale lo que la edición no toca.
        return {
            ok: true,
            status: 200,
            json: async () => ({ ...ACTIVO }),
            text: async () => "{}"
        }
    })
}

const guardado = () => peticiones.find((p) => p.method === "POST")

beforeEach(() => {
    peticiones = []
    currentAssetId = "xrp"
    _editingAsset = null
    editAssetModalState = null
    window.fetch = servidor()
    global.fetch = window.fetch
})

describe("globales de página que asigna otro módulo", () => {
    // Con `const` esto lanza «Assignment to constant variable» en cuanto se
    // abre o se cierra un diálogo, y el fallo llega disfrazado de otra cosa.
    it.each([
        ["editAssetModalState", () => (editAssetModalState = { isOpen: true })],
        ["assetModalState", () => (assetModalState = { isOpen: true })],
        ["confirmModalState", () => (confirmModalState = { onConfirm: null })],
        ["draggedAssetId", () => (draggedAssetId = "xrp")],
        ["currentAssetId", () => (currentAssetId = "xrp")]
    ])("%s se puede reasignar", (_nombre, asignar) => {
        expect(asignar).not.toThrow()
    })
})

describe("guardar una edición", () => {
    it("cambiar solo el color no lanza ningún error", async () => {
        montarModal()
        _editingAsset = { ...ACTIVO }

        await expect(submitEditAssetModal()).resolves.toBeUndefined()
        expect(guardado().body.color).toBe("#242222")
    })

    it("cierra el modal al terminar", async () => {
        montarModal()
        _editingAsset = { ...ACTIVO }

        await submitEditAssetModal()

        expect(document.getElementById("editAssetModalOverlay").classList.contains("hidden")).toBe(true)
        expect(editAssetModalState).toBeNull()
    })

    it("conserva compras, operaciones y conversiones", async () => {
        montarModal()
        _editingAsset = { ...ACTIVO }

        await submitEditAssetModal()

        expect(guardado().body.rows).toHaveLength(2)
        expect(guardado().body.operationRows).toHaveLength(1)
        expect(guardado().body.conversionRows).toHaveLength(1)
    })

    it("sin la tabla de operaciones en pantalla, se trae el activo del servidor", async () => {
        // El caso que borraba el historial: editar desde la vista de Activos
        // construía el payload leyendo una tabla que no existe, así que mandaba
        // el activo sin ninguna compra y el guardado las borraba.
        montarModal()
        _editingAsset = null

        await submitEditAssetModal()

        expect(peticiones[0].method).toBe("GET")
        expect(guardado().body.rows).toHaveLength(2)
        expect(guardado().body.color).toBe("#242222")
    })

    it("no guarda nada si no ha cambiado nada", async () => {
        montarModal({ color: ACTIVO.color })
        _editingAsset = { ...ACTIVO }

        await submitEditAssetModal()

        expect(guardado()).toBeUndefined()
    })

    it("guarda el nombre y el ticker nuevos", async () => {
        montarModal({ nombre: "Ripple", ticker: "KRAKEN:XRPEUR" })
        _editingAsset = { ...ACTIVO }

        await submitEditAssetModal()

        expect(guardado().body.name).toBe("Ripple")
        expect(guardado().body.marketSymbol).toBe("KRAKEN:XRPEUR")
        expect(guardado().body.finnhubSymbol).toBe("KRAKEN:XRPEUR")
    })
})

describe("cuando el guardado falla", () => {
    it("el aviso habla de la edición, no del nombre, y repite lo que dijo el servidor", () => {
        montarModal()
        const feedback = document.getElementById("editAssetSearchFeedback")

        reportEditAssetError(new Error('HTTP 400: {"ok": false, "error": "Ticker inválido"}'))

        expect(feedback.textContent).toContain("No se pudieron guardar los cambios del activo")
        expect(feedback.textContent).toContain("Ticker inválido")
        expect(feedback.textContent).not.toContain("nombre")
    })

    it("deja el modal abierto para poder corregir", async () => {
        montarModal()
        _editingAsset = { ...ACTIVO }
        window.fetch = servidor({ guardarFalla: { status: 400, error: "Ticker inválido" } })
        global.fetch = window.fetch

        await expect(submitEditAssetModal()).rejects.toThrow()

        expect(document.getElementById("editAssetModalOverlay").classList.contains("hidden")).toBe(false)
    })
})
