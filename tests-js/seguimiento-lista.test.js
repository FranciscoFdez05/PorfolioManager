// Watchlist: la pestaña «Seguimiento» es la lista que elige el usuario —activos
// del portfolio y activos nuevos— y «Wallets», la cripto de sus wallets.
//
// Un activo del portfolio se guarda solo como referencia (`assetId`): si la
// pestaña lo mezclara con Portfolio o Nuevos saldría repetido, y si lo filtrara
// como un activo nuevo con el mismo nombre que uno del portfolio, desaparecería.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

const ACTIVOS = [
    {
        id: "bitcoin",
        name: "Bitcoin",
        symbol: "BTC",
        type: "cripto",
        price: "60000",
        hasRows: true,
        marketSymbol: "BTC-EUR"
    },
    { id: "apple", name: "Apple", symbol: "AAPL", type: "acciones", price: "200", hasRows: true },
    { id: "spacex", name: "SpaceX", symbol: "SPX", type: "acciones", price: "", hasRows: false }
]

function ids(filtro) {
    _segFilterSrc = filtro
    return segFilteredItems().map((i) => i._segId)
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/seguimiento.js")
})

beforeEach(() => {
    window._seguimientoDatos = { lista: [], ocultos: [], overrides: {} }
    window._segOperacionesItems = []
    window._segWalletItems = [{ _segId: "wallet_btc", _fromWallets: true, name: "Bitcoin", type: "cripto" }]
    _segFilterType = "all"
    _segSearch = ""
})

describe("segAnadirReferencias", () => {
    it("añade referencias con el nombre y el tipo del activo, sin repetir", () => {
        const lista = segAnadirReferencias(
            [{ _segId: "seguir_apple", assetId: "apple" }],
            ["apple", "bitcoin"],
            ACTIVOS
        )

        expect(lista).toEqual([
            { _segId: "seguir_apple", assetId: "apple" },
            { _segId: "seguir_bitcoin", assetId: "bitcoin", nombre: "Bitcoin", tipo: "cripto" }
        ])
    })
})

describe("pestañas de la watchlist", () => {
    beforeEach(() => {
        window._seguimientoDatos.lista = [
            { _segId: "custom_1", nombre: "Nvidia", ticker: "NVDA", tipo: "acciones" },
            { _segId: "seguir_bitcoin", assetId: "bitcoin", nombre: "Bitcoin", tipo: "cripto" },
            // Un activo nuevo con el nombre de uno del portfolio se sigue ocultando, como antes.
            { _segId: "custom_2", nombre: "Apple", ticker: "", tipo: "acciones" },
            // El activo de esta referencia ya no existe.
            { _segId: "seguir_borrado", assetId: "borrado", nombre: "Borrado" }
        ]
        segMergeAndRender(ACTIVOS)
    })

    it("Seguimiento enseña la lista elegida, en su orden", () => {
        expect(ids("seguimiento")).toEqual(["custom_1", "seguir_bitcoin"])
    })

    it("Wallets enseña solo la cripto de las wallets", () => {
        expect(ids("wallets")).toEqual(["wallet_btc"])
    })

    it("la referencia no se repite en Portfolio ni en Nuevos", () => {
        expect(ids("portfolio")).toEqual(["portfolio_bitcoin", "portfolio_apple"])
        expect(ids("nuevos")).toEqual(["portfolio_spacex", "custom_1"])
    })

    it("la referencia trae el precio y el ticker del activo, con sus retoques", () => {
        window._seguimientoDatos.overrides = { portfolio_bitcoin: { tvSymbol: "BITSTAMP:BTCEUR" } }
        segMergeAndRender(ACTIVOS)
        const item = _segAllItems.find((i) => i._segId === "seguir_bitcoin")

        expect(item.price).toBe("60000")
        expect(item.marketSymbol).toBe("BTC-EUR")
        expect(item.tvSymbol).toBe("BITSTAMP:BTCEUR")
        expect(segOrigenTexto(item)).toBe("Portfolio")
    })

    it("su menú solo ofrece quitarla de Seguimiento, y quitarla no pide confirmar", () => {
        const item = _segAllItems.find((i) => i._segId === "seguir_bitcoin")
        const html = segBuildCard(item).innerHTML

        expect(html).toContain("Quitar de Seguimiento")
        expect(html).not.toContain("segEditBtn")

        segRemoveItem("seguir_bitcoin")
        expect(window._seguimientoDatos.lista.map((c) => c._segId)).not.toContain("seguir_bitcoin")
        expect(ids("portfolio")).toContain("portfolio_bitcoin")
    })
})

describe("paso «Activo del portfolio»", () => {
    it("marca y bloquea los que ya están en Seguimiento y filtra por nombre o ticker", () => {
        window._seguimientoDatos.lista = [{ _segId: "seguir_apple", assetId: "apple" }]
        window._segPortfolioAssets = ACTIVOS
        const caja = document.createElement("div")

        segPintarExistentes(caja, "", new Set(["bitcoin"]))
        const apple = caja.querySelector('input[value="apple"]')
        expect(apple.checked && apple.disabled).toBe(true)
        expect([...segMarcadosEn(caja)]).toEqual(["bitcoin"])

        segPintarExistentes(caja, "btc", new Set())
        expect([...caja.querySelectorAll("input")].map((i) => i.value)).toEqual(["bitcoin"])

        segPintarExistentes(caja, "zzz", new Set())
        expect(caja.textContent).toContain("Ningún activo coincide")
    })
})
