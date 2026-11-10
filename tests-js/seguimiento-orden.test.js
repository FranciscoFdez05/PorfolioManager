// Seguimiento: orden de las tarjetas elegido arrastrándolas.
//
// El orden se guarda como lista de `_segId`. Lo que no está en ella va detrás en
// el orden de siempre, y arrastrar con un filtro activo solo mueve lo visible.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

const ACTIVOS = [
    { id: "bitcoin", name: "Bitcoin", symbol: "BTC", type: "cripto", price: "1", hasRows: true },
    { id: "apple", name: "Apple", symbol: "AAPL", type: "acciones", price: "1", hasRows: true }
]

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/seguimiento.js")
})

beforeEach(() => {
    window._seguimientoDatos = { lista: [], ocultos: [], overrides: {}, orden: [] }
    window._segOperacionesItems = []
    window._segWalletItems = [{ _segId: "wallet_btc", _fromWallets: true, name: "Bitcoin", type: "cripto" }]
    _segFilterType = "all"
    _segFilterSrc = "all"
    _segSearch = ""
})

describe("segAplicarOrden", () => {
    const items = ["a", "b", "c", "d"].map((_segId) => ({ _segId }))

    it("sin orden guardado deja el orden de siempre", () => {
        expect(segAplicarOrden(items, []).map((i) => i._segId)).toEqual(["a", "b", "c", "d"])
    })

    it("pone delante lo ordenado y deja detrás lo nuevo, en su orden", () => {
        expect(segAplicarOrden(items, ["c", "a", "zz"]).map((i) => i._segId)).toEqual(["c", "a", "b", "d"])
    })

    it("no modifica la lista recibida", () => {
        segAplicarOrden(items, ["d"])
        expect(items.map((i) => i._segId)).toEqual(["a", "b", "c", "d"])
    })
})

describe("segFusionarOrden", () => {
    it("sin filtro, el orden visible es el orden completo", () => {
        expect(segFusionarOrden(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"])
    })

    it("con filtro, reparte las visibles por sus huecos y no mueve las demás", () => {
        expect(segFusionarOrden(["a", "b", "c", "d"], ["d", "b"])).toEqual(["a", "d", "c", "b"])
    })

    it("ignora ids visibles que ya no están en la lista", () => {
        expect(segFusionarOrden(["a", "b"], ["x", "b", "a"])).toEqual(["b", "a"])
    })
})

describe("segMergeAndRender", () => {
    it("aplica el orden guardado a todas las fuentes mezcladas", () => {
        window._seguimientoDatos.orden = ["wallet_btc", "portfolio_apple"]

        segMergeAndRender(ACTIVOS)

        expect(_segAllItems.map((i) => i._segId)).toEqual(["wallet_btc", "portfolio_apple", "portfolio_bitcoin"])
    })
})
