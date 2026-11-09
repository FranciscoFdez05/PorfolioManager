// Pestaña Tokens del detalle de seguimientos: además de los tokens de ETH/BNB
// lista la moneda propia de cada wallet (BTC, ETH, SOL, XRP), y una wallet que
// nunca se ha leído sale como «Sin leer», no con un «—» que parece un cero.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarModulo, cargarScript } from "./cargar.js"

const global = (expresion) => runInThisContext(expresion)

const REDES = [
    { clave: "btc", nombre: "Bitcoin", simbolo: "BTC", visorTokens: false },
    { clave: "eth", nombre: "Ethereum", simbolo: "ETH", visorTokens: true },
    { clave: "sol", nombre: "Solana", simbolo: "SOL", visorTokens: false }
]

const BTC_SIN_LEER = { id: "w-btc", alias: "Bitcoin Trezor", red: "btc", saldo: "", saldoFecha: "" }
const ETH = { id: "w-eth", alias: "ETH Ledger", red: "eth", saldo: "0.26", saldoFecha: "2026-11-03T10:00:00Z", valorEur: "541.11" }
const SOL = { id: "w-sol", alias: "SOL Ledger", red: "sol", saldo: "2.33", saldoFecha: "2026-11-03T10:00:00Z", valorEur: "194.28" }

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarModulo("js/cripto/wallets-seguimiento.js")
})

beforeEach(() => {
    global("walletsEstado").redes = REDES
    global("walletsEstado").wallets = [BTC_SIN_LEER, ETH, SOL]
})

describe("pestaña Tokens", () => {
    it("está en un seguimiento sin redes con tokens", () => {
        const pestana = global("WALLETS_SEG_PESTANAS").find((p) => p.clave === "tokens")
        expect(pestana.disponible({ wallets: [SOL] })).toBe(true)
    })

    it("sin ETH/BNB enseña las monedas de red sin leer nada de Etherscan", () => {
        const html = window.walletsSegTokensVisorHtml({}, { wallets: [BTC_SIN_LEER, SOL] })
        expect(html).toContain("<strong>SOL</strong>")
        expect(html).toContain("<strong>BTC</strong>")
        expect(html).toContain("Sin leer")
        expect(html).not.toContain("walletsSegTokensCargarBtn")
    })

    it("con tokens leídos pone primero las monedas de red y suma su valor", () => {
        const estado = { tokens: { cargando: false, lista: [], sinLeer: 0, errores: [], fecha: "2026-11-03T10:00:00Z" } }
        const html = window.walletsSegTokensVisorHtml(estado, { wallets: [ETH, SOL] })
        expect(html.indexOf("<strong>ETH</strong>")).toBeLessThan(html.indexOf("<strong>SOL</strong>"))
        expect(html).toMatch(/735,39\s€/)
    })

    it("el contador espera a los tokens solo si el seguimiento los tiene", () => {
        expect(window.walletsSegContadorTokens({}, { wallets: [ETH] })).toBeNull()
        expect(window.walletsSegContadorTokens({}, { wallets: [BTC_SIN_LEER, SOL] })).toBe(2)
        const leidos = { tokens: { cargando: false, lista: [{ walletId: "w-eth" }] } }
        expect(window.walletsSegContadorTokens(leidos, { wallets: [ETH, SOL] })).toBe(3)
    })
})

describe("etiqueta de la moneda de la red en el historial", () => {
    const TODAS_LAS_REDES = [
        { clave: "btc", nombre: "Bitcoin", simbolo: "BTC" },
        { clave: "eth", nombre: "Ethereum", simbolo: "ETH", exploradorToken: "https://etherscan.io/token/{contrato}" },
        { clave: "bnb", nombre: "BNB Smart Chain", simbolo: "BNB", exploradorToken: "https://bscscan.com/token/{contrato}" },
        { clave: "sol", nombre: "Solana", simbolo: "SOL" },
        { clave: "xrp", nombre: "XRP Ledger", simbolo: "XRP" }
    ]

    beforeEach(() => {
        global("walletsEstado").redes = TODAS_LAS_REDES
        global("walletsEstado").tokensMarcados = []
        global("walletsEstado").tokensVerificados = []
    })

    it.each(TODAS_LAS_REDES.map((red) => [red.clave, red.simbolo]))("%s: sin contrato es %s real", (clave, simbolo) => {
        const html = window.walletsSegTokenHtml({ simbolo, contrato: "" }, clave, false)
        expect(html).toContain(`${simbolo} real · moneda de la red`)
    })

    it("no la pone si el símbolo no es el de esa red", () => {
        expect(window.walletsSegTokenHtml({ simbolo: "ETH", contrato: "" }, "sol", false)).toBe("")
    })

    it("no la pone en una red desconocida", () => {
        expect(window.walletsSegTokenHtml({ simbolo: "BTC", contrato: "" }, "desconocida", false)).toBe("")
    })

    it("un token con contrato que se llama como la moneda sigue siendo imitación", () => {
        const html = window.walletsSegTokenHtml({ simbolo: "ETH", contrato: "0xfalso" }, "eth", false)
        expect(html).not.toContain("real · moneda de la red")
        expect(html).toContain("Imitación")
    })
})

describe("saldo en la fila de Direcciones", () => {
    it("una wallet sin leer dice «Sin leer», no «—»", () => {
        expect(window.walletsSegSaldoMiembroHtml(BTC_SIN_LEER, REDES[0])).toContain("Sin leer")
    })

    it("un saldo leído de cero sale como 0", () => {
        const vacia = { ...BTC_SIN_LEER, saldo: "0", saldoFecha: "2026-11-03T10:00:00Z" }
        expect(window.walletsSegSaldoMiembroHtml(vacia, REDES[0])).toContain("0 BTC")
    })
})
