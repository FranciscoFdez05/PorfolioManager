// Lista «Seguimiento» de la Watchlist: cada moneda o token de las wallets lleva
// un menú ··· para ponerle el ticker con el que se cotiza, TradingView por defecto.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

const MONEDA = { id: "moneda-bnb", tipo: "moneda", red: "bnb", redNombre: "BNB Smart Chain", simbolo: "BNB", nombre: "BNB Smart Chain", contrato: "", assetId: "", proveedor: "", ticker: "" }
const TOKEN = { id: "token-eth-0xpepe", tipo: "token", red: "eth", redNombre: "Ethereum", simbolo: "PEPE", nombre: "Pepe", contrato: "0xpepe", assetId: "", proveedor: "yahoo", ticker: "PEPE-USD" }

function respuesta(cuerpo) {
    return { ok: true, status: 200, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo) }
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarModulo("js/cartera/assets.js")
    cargarScript("js/cripto/wallets.js")
    cargarScript("js/cripto/wallets-seguimiento.js")
    cargarScript("js/analisis/seguimiento.js")
})

beforeEach(() => {
    window._segPortfolioAssets = []
    window._segWalletItems = [window.segWalletItem(MONEDA, []), window.segWalletItem(TOKEN, [])]
})

afterEach(() => {
    document.getElementById("walletsSegPrecioOverlay")?.remove()
    vi.unstubAllGlobals()
})

describe("menú ··· de las wallets", () => {
    it("sin ticker solo ofrece ponerlo", () => {
        const html = window.segWalletMenuHtml(window._segWalletItems[0])
        expect(html).toContain("Poner ticker de precio")
        expect(html).not.toContain("segWalletTickerQuitarBtn")
    })

    it("con ticker ofrece cambiarlo y quitarlo", () => {
        const html = window.segWalletMenuHtml(window._segWalletItems[1])
        expect(html).toContain("Cambiar ticker de precio")
        expect(html).toContain("segWalletTickerQuitarBtn")
    })
})

describe("ventana del ticker", () => {
    it("sin ticker propone TradingView", () => {
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        expect(document.getElementById("walletsSegPrecioProveedor").value).toBe("tradingview")
        expect(document.getElementById("walletsSegPrecioTicker").value).toBe("")
    })

    it("con ticker abre con su proveedor y su ticker", () => {
        window.segAbrirTickerWallet("wallet_token-eth-0xpepe")
        expect(document.getElementById("walletsSegPrecioProveedor").value).toBe("yahoo")
        expect(document.getElementById("walletsSegPrecioTicker").value).toBe("PEPE-USD")
    })
})

describe("previsualización del ticker", () => {
    const XRP = { symbol: "BITVAVO:XRPEUR", description: "XRP / Euro", type: "crypto", exchange: "BITVAVO", provider: "tradingview", price: "2,10", currency: "EUR", change: "+1,50%" }
    const campo = () => document.getElementById("walletsSegPrecioTicker")
    const boton = () => document.getElementById("walletsSegPrecioBuscar")
    const tarjetas = () => document.querySelectorAll("#walletsSegPrecioResultados .assetSearchResultBtn")

    function stubBusqueda(results) {
        const fetchMock = vi.fn(async () => respuesta({ ok: true, results }))
        vi.stubGlobal("fetch", fetchMock)
        return fetchMock
    }

    async function buscar() {
        boton().click()
        await vi.waitFor(() => expect(boton().disabled).toBe(false))
    }

    it("busca lo escrito en el proveedor elegido y enseña precio y variación", async () => {
        const fetchMock = stubBusqueda([XRP])
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        expect(boton().textContent).toBe("Buscar TradingView")
        campo().value = "BITVAVO:XRPEUR"
        await buscar()
        const url = new URL(fetchMock.mock.calls[0][0], "http://localhost")
        expect(url.pathname).toBe("/api/tradingview/search")
        expect(url.searchParams.get("q")).toBe("BITVAVO:XRPEUR")
        expect(tarjetas()).toHaveLength(1)
        expect(tarjetas()[0].textContent).toContain("2,10 EUR")
        expect(tarjetas()[0].textContent).toContain("+1,50%")
    })

    it("con el campo vacío busca el símbolo del activo", async () => {
        const fetchMock = stubBusqueda([])
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        await buscar()
        expect(new URL(fetchMock.mock.calls[0][0], "http://localhost").searchParams.get("q")).toBe("BNB")
    })

    it("al elegir, rellena el ticker y deja solo su tarjeta", async () => {
        stubBusqueda([XRP, { ...XRP, symbol: "KRAKEN:XRPEUR", exchange: "KRAKEN" }])
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        await buscar()
        expect(tarjetas()).toHaveLength(2)
        tarjetas()[0].click()
        expect(campo().value).toBe("BITVAVO:XRPEUR")
        expect(tarjetas()).toHaveLength(1)
        expect(document.getElementById("walletsSegPrecioFeedback").textContent).toContain("BITVAVO:XRPEUR")
    })

    it("un resultado de otro proveedor cambia también el proveedor", async () => {
        stubBusqueda([{ ...XRP, provider: "yahoo", symbol: "XRP-EUR" }])
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        await buscar()
        tarjetas()[0].click()
        expect(document.getElementById("walletsSegPrecioProveedor").value).toBe("yahoo")
        expect(boton().textContent).toBe("Buscar Yahoo Finance")
        expect(tarjetas()).toHaveLength(1)
    })

    it("avisa si el elegido no tiene cotización", async () => {
        stubBusqueda([{ ...XRP, price: "", change: "" }])
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        await buscar()
        tarjetas()[0].click()
        const aviso = document.getElementById("walletsSegPrecioFeedback")
        expect(aviso.textContent).toContain("sin cotización disponible")
        expect(aviso.classList.contains("assetSearchError")).toBe(true)
    })

    it.each([
        ["editar el ticker", () => campo().dispatchEvent(new Event("input", { bubbles: true }))],
        [
            "cambiar de proveedor",
            () => {
                const select = document.getElementById("walletsSegPrecioProveedor")
                select.value = "eodhd"
                select.dispatchEvent(new Event("change", { bubbles: true }))
            }
        ]
    ])("%s quita la previsualización", async (_, accion) => {
        stubBusqueda([XRP])
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        await buscar()
        expect(tarjetas()).toHaveLength(1)
        accion()
        expect(tarjetas()).toHaveLength(0)
        expect(document.getElementById("walletsSegPrecioFeedback").classList.contains("hidden")).toBe(true)
    })

    it("si la búsqueda falla, lo dice y deja buscar otra vez", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: "Sin conexión" }) })))
        vi.spyOn(console, "error").mockImplementation(() => {})
        window.segAbrirTickerWallet("wallet_moneda-bnb")
        await buscar()
        expect(document.getElementById("walletsSegPrecioFeedback").textContent).toContain("Sin conexión")
        expect(boton().disabled).toBe(false)
    })
})

describe("precios muy pequeños", () => {
    it("una memecoin no sale como 0,00", () => {
        expect(window.segFormatoPrecio(0.00000493, "USD")).toMatch(/^0,00000493\s\$$/)
    })

    it("un precio normal sigue con 2 decimales", () => {
        expect(window.segFormatoPrecio(625.884, "EUR")).toMatch(/^625,88\s€$/)
    })

    it("cotiza con el precio exacto, no con el redondeado", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => respuesta({ ok: true, price: "0,00", currentPrice: 1e-7, change: "+3,35%", currency: "USDT" }))
        )
        const item = window._segWalletItems[1]

        expect(await window.segCotizarWalletItem(item)).toBe(true)
        expect(window.parseLooseNumber(item.price)).toBe(1e-7)
    })
})

describe("guardar el ticker", () => {
    it("envía la moneda sin contrato y cotiza solo esa entrada", async () => {
        const conTicker = { ...MONEDA, proveedor: "tradingview", ticker: "BINANCE:BNBEUR" }
        const pedidas = []
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url, opciones) => {
                pedidas.push({ url: String(url), cuerpo: opciones?.body })
                if (String(url).includes("/api/wallets/watchlist")) return respuesta({ ok: true, entradas: [conTicker, TOKEN] })
                if (String(url).includes("/api/market/quote")) return respuesta({ ok: true, price: 500, change: "1%", currency: "EUR" })
                return respuesta({ ok: true })
            })
        )

        const error = await window.segEnviarTickerWallet(window._segWalletItems[0], "/api/wallets/tokens/precio", {
            proveedor: "tradingview",
            ticker: "BINANCE:BNBEUR"
        })

        expect(error).toBe("")
        expect(JSON.parse(pedidas[0].cuerpo)).toEqual({ red: "bnb", contrato: "", proveedor: "tradingview", ticker: "BINANCE:BNBEUR" })
        const cotizaciones = pedidas.filter((p) => p.url.includes("/api/market/quote"))
        expect(cotizaciones).toHaveLength(1)
        expect(cotizaciones[0].url).toContain("BNBEUR")
        const [moneda, token] = window._segWalletItems
        expect(moneda.ticker).toBe("BINANCE:BNBEUR")
        expect(moneda.price).toBe("500")
        expect(token.price).toBe("")
    })

    it("devuelve el error del servidor y deja la entrada como estaba", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "No se encuentra cotización" }), text: async () => "" }))
        )
        const antes = window._segWalletItems[0]

        const error = await window.segEnviarTickerWallet(antes, "/api/wallets/tokens/precio", { proveedor: "yahoo", ticker: "X" })

        expect(error).toContain("No se encuentra cotización")
        expect(window._segWalletItems[0]).toBe(antes)
    })
})
