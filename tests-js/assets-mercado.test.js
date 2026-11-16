// Pestaña "Mercado" de la ficha del activo.
//
// Se comprueba lo que el panel promete: que cada cifra sale de su campo, que
// un dato que no existe se pinta como "—" (o se omite) en vez de inventarse,
// que una cripto sin derivados lo dice, y que un ticker sin mercado no llega a
// pedir nada al servidor.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runInThisContext } from "node:vm"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/fundamentales.js")
    cargarScript("js/cartera/assets-mercado.js")
})

function html(texto) {
    const div = document.createElement("div")
    div.innerHTML = texto
    return div
}

function tarjetas(nodo) {
    return Object.fromEntries(
        [...nodo.querySelectorAll(".mkCard")].map((c) => [
            c.querySelector(".mkCardLabel").textContent,
            c.querySelector(".mkCardValue").textContent
        ])
    )
}

const moneda = {
    base_currency: "BTC",
    market_cap_calc: 1.3e12,
    market_cap_diluted_calc: 1.37e12,
    circulating_supply: 20.11e6,
    total_supply: 20.11e6,
    max_supply: 21e6,
    "24h_vol_cmc": 5.4e10,
    "24h_vol_change|5": 6.5,
    crypto_total_rank: 1,
    crypto_common_categories: ["layer-1", "<b>x</b>"]
}

describe("mkBuildHtml cripto", () => {
    const stats = { close: 64000, currency: "EUR", "Recommend.All": 0.6 }

    it("pinta capitalización, suministro y FDV desde la fila de moneda", () => {
        const nodo = html(mkBuildHtml({ isCrypto: true, stats, coin: moneda, derivatives: null }, { currency: "EUR" }))
        const c = tarjetas(nodo)

        expect(c["Capitalización de mercado"]).toContain("$")
        expect(c["Suministro máximo"]).toContain("BTC")
        expect(c["Vol. / Cap. de mercado"]).toBe("4,2 %")
        expect(nodo.textContent).toContain("95,8 % del máximo")
    })

    it("una moneda sin tope de suministro lo dice", () => {
        const nodo = html(
            mkBuildHtml({ isCrypto: true, stats, coin: { ...moneda, max_supply: null }, derivatives: null }, { currency: "EUR" })
        )
        expect(tarjetas(nodo)["Suministro máximo"]).toBe("Sin límite")
    })

    it("sin perpetuo en Binance lo dice y no pinta tarjetas de derivados", () => {
        const nodo = html(mkBuildHtml({ isCrypto: true, stats, coin: moneda, derivatives: null }, { currency: "EUR" }))

        expect(nodo.textContent).toContain("Binance no tiene un perpetuo USDT")
        expect(tarjetas(nodo)["Interés abierto"]).toBeUndefined()
    })

    it("con perpetuo pinta tasa, interés abierto y volumen de futuros", () => {
        const derivatives = {
            symbol: "BTCUSDT", markPrice: 64000, basisPct: -0.03, fundingRate: 0.0001,
            nextFundingTime: null, openInterestUsd: 6e9, volume24hUsd: 1e10
        }
        const nodo = html(mkBuildHtml({ isCrypto: true, stats, coin: moneda, derivatives }, { currency: "EUR" }))
        const c = tarjetas(nodo)

        expect(c["Tasa de financiación"]).toBe("+0,0100 %")
        expect(c["Interés abierto"]).toContain("$")
        expect(c["Volumen de futuros (24 h)"]).toContain("$")
        expect(nodo.textContent).toContain("BTCUSDT perpetuo")
    })

    it("el error del proveedor se enseña en lugar de unas tarjetas vacías", () => {
        const nodo = html(
            mkBuildHtml({ isCrypto: true, stats, coin: null, coinError: "TradingView devolvió HTTP 503", derivatives: null }, { currency: "EUR" })
        )
        expect(nodo.textContent).toContain("TradingView devolvió HTTP 503")
    })

    it("las categorías se escapan", () => {
        const nodo = html(mkBuildHtml({ isCrypto: true, stats, coin: moneda, derivatives: null }, { currency: "EUR" }))

        expect(nodo.querySelector(".mkChips b")).toBeNull()
        expect(nodo.querySelector(".mkChips").textContent).toContain("<b>x</b>")
    })
})

describe("mkBuildHtml valores tradicionales", () => {
    it("solo pinta las tarjetas de capital que tienen dato", () => {
        const stats = { close: 100, currency: "USD", market_cap_basic: 5e12, aum: null, total_shares_outstanding: null, volume: 1e7 }
        const nodo = html(mkBuildHtml({ isCrypto: false, stats }, { currency: "USD" }))
        const c = tarjetas(nodo)

        expect(c["Capitalización de mercado"]).toBeDefined()
        expect(c["Patrimonio del fondo"]).toBeUndefined()
        expect(c["Acciones en circulación"]).toBeUndefined()
        expect(c["Volumen medio (30 d)"]).toBe("—")
    })

    it("un ETF enseña su patrimonio", () => {
        const stats = { close: 100, currency: "EUR", aum: 2e10 }
        const nodo = html(mkBuildHtml({ isCrypto: false, stats }, { currency: "EUR" }))

        expect(tarjetas(nodo)["Patrimonio del fondo"]).toContain("€")
    })

    it("el ticker que el scanner no conoce da un mensaje, no una ficha vacía", () => {
        const nodo = html(mkBuildHtml({ isCrypto: false, stats: null }, { currency: "EUR" }))

        expect(nodo.querySelector(".mkMessage")).not.toBeNull()
        expect(nodo.querySelector(".mkCard")).toBeNull()
    })
})

describe("mkVersus", () => {
    it.each([
        [null, 10],
        [10, null],
        [10, 0]
    ])("sin dato (%s vs %s) es raya", (close, ma) => {
        expect(mkVersus(close, ma)).toBe("—")
    })

    it("precio sobre la media es positivo y bajo la media negativo", () => {
        expect(mkVersus(110, 100)).toContain("fnPos")
        expect(mkVersus(90, 100)).toContain("fnNeg")
    })
})

describe("renderAssetMercadoSection", () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="assetMercadoSection"></div>`
        globalThis.buildTVSymbol = (asset) => asset.tvSymbol || asset.symbol
        globalThis.fetch = vi.fn()
        runInThisContext(`_mkCache.clear()`)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("un ticker sin mercado no llama al servidor", () => {
        assetMercadoRegistrar({ symbol: "BTCUSD", currency: "EUR" })
        renderAssetMercadoSection()

        expect(fetch).not.toHaveBeenCalled()
        expect(document.getElementById("assetMercadoSection").textContent).toContain("MERCADO:TICKER")
    })

    it("pide el ticker en mayúsculas y pinta la respuesta", async () => {
        fetch.mockResolvedValue({
            json: async () => ({ ok: true, isCrypto: false, stats: { close: 1, currency: "USD", market_cap_basic: 1e9 } })
        })
        assetMercadoRegistrar({ tvSymbol: "nasdaq:aapl", currency: "USD" })

        renderAssetMercadoSection()
        await vi.waitFor(() => expect(document.querySelector(".mkCard")).not.toBeNull())

        expect(fetch.mock.calls[0][0]).toBe("/api/market/ficha?symbol=NASDAQ%3AAAPL")
    })

    it("un error del servidor se enseña con opción de reintentar", async () => {
        fetch.mockResolvedValue({ json: async () => ({ ok: false, error: "TradingView devolvió HTTP 503" }) })
        assetMercadoRegistrar({ tvSymbol: "NASDAQ:AAPL", currency: "USD" })

        renderAssetMercadoSection()
        await vi.waitFor(() => expect(document.querySelector("[data-mk-retry]")).not.toBeNull())

        expect(document.getElementById("assetMercadoSection").textContent).toContain("HTTP 503")
    })

    it("la segunda apertura sirve de caché sin repetir la petición", async () => {
        fetch.mockResolvedValue({ json: async () => ({ ok: true, isCrypto: false, stats: { close: 1, currency: "USD" } }) })
        assetMercadoRegistrar({ tvSymbol: "NASDAQ:AAPL", currency: "USD" })

        renderAssetMercadoSection()
        await vi.waitFor(() => expect(document.querySelector(".mkCard")).not.toBeNull())
        renderAssetMercadoSection()

        expect(fetch).toHaveBeenCalledTimes(1)
    })
})

describe("mkCompact", () => {
    it.each([
        [1.29e12, "1,29 B"],
        [3.01e10, "30,1 mil M"],
        [6.07346e9, "6,07 mil M"],
        [4.4e7, "44 M"],
        [950, "950"],
        [12.345, "12,35"]
    ])("%s -> %s", (valor, esperado) => {
        expect(mkCompact(valor)).toBe(esperado)
    })

    it("la misma escala para cifras de un mismo orden", () => {
        expect(mkCompact(6.0e9).endsWith("mil M")).toBe(true)
        expect(mkCompact(3.0e10).endsWith("mil M")).toBe(true)
    })
})
