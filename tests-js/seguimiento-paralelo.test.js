// Seguimiento: peticiones en paralelo al abrir la página y al cotizar.
//
// Las cotizaciones por ticker y los tres GET de entrada se hacían uno tras otro,
// así que su latencia se sumaba. Ahora salen a la vez (con tope en las
// cotizaciones). Lo que no puede cambiar: se pide todo, una vez, y un fallo
// suelto no se lleva por delante al resto.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/seguimiento.js")
})

let enCurso
let maximoEnCurso
let pedidas

function respuesta(cuerpo, ok = true) {
    return { ok, json: () => Promise.resolve(cuerpo) }
}

// Una cotización tarda un par de turnos del bucle de eventos, para que se solapen.
function fetchConCuota(cuerpoDe = (symbol) => ({ ok: true, price: `${symbol.length}.5` })) {
    return vi.fn(async (url) => {
        const direccion = new URL(url, "http://localhost")
        if (direccion.pathname !== "/api/market/quote") return respuesta({})
        const simbolo = direccion.searchParams.get("symbol")
        pedidas.push(simbolo)
        enCurso++
        maximoEnCurso = Math.max(maximoEnCurso, enCurso)
        await new Promise((resolve) => setTimeout(resolve, 5))
        enCurso--
        const cuerpo = cuerpoDe(simbolo)
        return respuesta(cuerpo, cuerpo !== null)
    })
}

beforeEach(() => {
    enCurso = 0
    maximoEnCurso = 0
    pedidas = []
    window._seguimientoDatos = { lista: [], ocultos: [], overrides: {}, orden: [], listas: {} }
    window._segWalletItems = []
    window._segPortfolioAssets = []
})

describe("segEnParalelo", () => {
    it("procesa todos los elementos una vez con el tope pedido", async () => {
        const vistos = []
        let simultaneos = 0
        let maximo = 0
        await segEnParalelo(
            Array.from({ length: 12 }, (_, i) => i),
            async (i) => {
                simultaneos++
                maximo = Math.max(maximo, simultaneos)
                await new Promise((resolve) => setTimeout(resolve, 2))
                simultaneos--
                vistos.push(i)
            },
            3
        )
        expect(vistos.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i))
        expect(maximo).toBe(3)
    })

    it("con menos elementos que el tope no lanza más trabajadores de los necesarios", async () => {
        let maximo = 0
        let simultaneos = 0
        await segEnParalelo([1, 2], async () => {
            simultaneos++
            maximo = Math.max(maximo, simultaneos)
            await new Promise((resolve) => setTimeout(resolve, 2))
            simultaneos--
        })
        expect(maximo).toBe(2)
    })

    it("con una lista vacía no hace nada", async () => {
        const tarea = vi.fn()
        await segEnParalelo([], tarea)
        expect(tarea).not.toHaveBeenCalled()
    })

    it("no modifica la lista original", async () => {
        const original = [1, 2, 3]
        await segEnParalelo(original, async () => {})
        expect(original).toEqual([1, 2, 3])
    })
})

describe("segRefreshCustomPrices", () => {
    function listaDeSeguimiento(n) {
        return Array.from({ length: n }, (_, i) => ({ _segId: `c${i}`, ticker: `T${i}`, name: `N${i}` }))
    }

    it("cotiza todos los que tienen ticker, a la vez y con tope de cuatro", async () => {
        window._seguimientoDatos.lista = [...listaDeSeguimiento(10), { _segId: "sin", name: "Sin ticker" }]
        window.fetch = fetchConCuota()

        await segRefreshCustomPrices()

        expect(pedidas.sort()).toEqual(
            listaDeSeguimiento(10)
                .map((c) => c.ticker)
                .sort()
        )
        expect(maximoEnCurso).toBeGreaterThan(1)
        expect(maximoEnCurso).toBeLessThanOrEqual(4)
        expect(window._seguimientoDatos.lista.filter((c) => c.price).length).toBe(10)
    })

    it("un fallo suelto no impide actualizar el resto", async () => {
        window._seguimientoDatos.lista = listaDeSeguimiento(6)
        window.fetch = fetchConCuota((simbolo) => (simbolo === "T2" ? null : { ok: true, price: "9" }))

        await segRefreshCustomPrices()

        const conPrecio = window._seguimientoDatos.lista.filter((c) => c.price).map((c) => c.ticker)
        expect(conPrecio.sort()).toEqual(["T0", "T1", "T3", "T4", "T5"])
    })

    it("sin ningún ticker no hace peticiones", async () => {
        window._seguimientoDatos.lista = [{ _segId: "a", name: "A" }]
        window.fetch = fetchConCuota()

        await segRefreshCustomPrices()

        expect(pedidas).toEqual([])
    })
})

describe("segRefreshWalletPrices", () => {
    it("cotiza solo las entradas con ticker propio y en paralelo", async () => {
        window._segWalletItems = [
            ...Array.from({ length: 6 }, (_, i) => ({
                _segId: `w${i}`,
                _quoteTicker: true,
                ticker: `W${i}`,
                marketProvider: "tradingview"
            })),
            { _segId: "ajena", _quoteTicker: false, ticker: "NO", marketProvider: "" }
        ]
        window.fetch = fetchConCuota()

        await segRefreshWalletPrices()

        expect(pedidas.sort()).toEqual(["W0", "W1", "W2", "W3", "W4", "W5"])
        expect(maximoEnCurso).toBeGreaterThan(1)
        expect(maximoEnCurso).toBeLessThanOrEqual(4)
        expect(window._segWalletItems.filter((item) => item.price).length).toBe(6)
    })
})

describe("segLoadWalletItems", () => {
    const entrada = {
        id: "e1",
        tipo: "token",
        nombre: "Tok",
        redNombre: "Red",
        simbolo: "TOK",
        red: "r",
        contrato: "c"
    }

    it("usa la petición ya lanzada en vez de pedir otra", async () => {
        window.fetch = vi.fn()

        const items = await segLoadWalletItems([], Promise.resolve([entrada]))

        expect(window.fetch).not.toHaveBeenCalled()
        expect(items).toHaveLength(1)
        expect(items[0]._segId).toBe("wallet_e1")
    })

    it("sin petición previa la hace él", async () => {
        window.fetch = vi.fn(() => Promise.resolve(respuesta({ entradas: [entrada] })))

        const items = await segLoadWalletItems([])

        expect(window.fetch).toHaveBeenCalledTimes(1)
        expect(items).toHaveLength(1)
    })

    it("si la petición falla, la lista sale vacía", async () => {
        window.fetch = vi.fn(() => Promise.reject(new Error("sin red")))
        expect(await segLoadWalletItems([])).toEqual([])

        window.fetch = vi.fn(() => Promise.resolve(respuesta({}, false)))
        expect(await segLoadWalletItems([])).toEqual([])
    })
})

describe("initSeguimientoLogic", () => {
    it("lanza activos, operaciones y wallets a la vez, sin esperar a ninguna", async () => {
        const pendientes = []
        window.fetch = vi.fn((url) => new Promise((resolve) => pendientes.push({ url, resolve })))

        const arranque = initSeguimientoLogic().catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(pendientes.map((p) => p.url).sort()).toEqual(
            expect.arrayContaining(["/api/activos", "/api/operaciones", "/api/wallets/watchlist"])
        )
        pendientes.forEach((p) => p.resolve(respuesta({}, false)))
        await arranque
    })
})
