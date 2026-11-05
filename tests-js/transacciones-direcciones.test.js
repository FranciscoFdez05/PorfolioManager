// Columnas de wallet de Transacciones: las filas importadas guardan el nombre del
// seguimiento, pero la tabla enseña la dirección abreviada.
import { runInThisContext } from "node:vm"

import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const DIRECCION = "0xd2674da94285660c9b2353131bef2d8211369a4b"
const DERIVADA = "bc1qfpeps3wcmzk422hvm5jeq5lelnqlzznjwyfy69"
const ETH = {
    id: "w-eth",
    alias: "Cuenta",
    seguimiento: "Wallets 2026",
    seguimientoClave: "wallets 2026",
    assetId: "ethereum",
    valorEnmascarado: "0xd2674d…9a4b",
    recientes: []
}
const SOL = { ...ETH, id: "w-sol", assetId: "solana", valorEnmascarado: "2UL8hbNa…khNL" }
const FILA = {
    id: "wallet-abc",
    assetId: "ethereum",
    assetName: "Ethereum",
    hashTransaccion: "0xABC",
    walletDesde: DIRECCION,
    walletDestino: "Wallets 2026"
}

const fijarWallets = (wallets) => {
    globalThis.__walletsPrueba = wallets
    runInThisContext("walletsEstado = { wallets: globalThis.__walletsPrueba }")
}
// Las celdas de wallet son la sexta y la séptima de la fila.
const celdas = (fila) => {
    const tr = window.buildTransaccionRow(fila)
    return { origen: tr.children[5], destino: tr.children[6] }
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarScript("js/cripto/transacciones.js")
})

beforeEach(() => fijarWallets([ETH, SOL]))

describe("dirección de la wallet propia en la tabla", () => {
    it("sustituye el nombre por la dirección de la wallet de ese activo", () => {
        const { destino } = celdas(FILA)
        expect(destino.textContent).toBe("0xd2674d…9a4b")
        expect(destino.title).toBe("Wallets 2026: 0xd2674d…9a4b")
    })

    it("abrevia la dirección de la contraparte y deja la completa en el título", () => {
        const { origen } = celdas(FILA)
        expect(origen.textContent).toBe("0xd2674d…9a4b")
        expect(origen.title).toBe(DIRECCION)
    })

    it("prefiere la dirección exacta del movimiento, la única en una xpub", () => {
        const movimiento = { hash: "0xabc", simbolo: "ETH", contrato: "", propia: DERIVADA }
        fijarWallets([{ ...ETH, valorEnmascarado: "zpub6rFR…H1r1", recientes: [movimiento] }])
        expect(celdas(FILA).destino.textContent).toBe("bc1qfpep…fy69")
    })

    it("resuelve también el origen de un envío", () => {
        const { origen } = celdas({ ...FILA, walletDesde: "Wallets 2026", walletDestino: DIRECCION })
        expect(origen.textContent).toBe("0xd2674d…9a4b")
    })

    it("no distingue mayúsculas en el nombre y encuentra por alias", () => {
        expect(celdas({ ...FILA, walletDestino: "WALLETS 2026" }).destino.textContent).toBe("0xd2674d…9a4b")
        expect(celdas({ ...FILA, walletDestino: "Cuenta" }).destino.textContent).not.toBe("Cuenta")
    })

    it("con varias wallets posibles deja el nombre antes que inventar la dirección", () => {
        const fila = { ...FILA, assetId: "stablecoin-USDC", assetName: "USDC" }
        expect(celdas(fila).destino.textContent).toBe("Wallets 2026")
        fijarWallets([ETH, { ...ETH, id: "w-eth-2" }])
        expect(celdas(FILA).destino.textContent).toBe("Wallets 2026")
    })

    it("un token de un seguimiento con una sola wallet usa esa wallet", () => {
        fijarWallets([ETH])
        const fila = { ...FILA, assetId: "stablecoin-USDC", assetName: "USDC" }
        expect(celdas(fila).destino.textContent).toBe("0xd2674d…9a4b")
    })

    it("respeta lo escrito a mano aunque coincida con el nombre de una wallet", () => {
        const fila = { ...FILA, id: "transaccion-1", walletDestino: "Wallets 2026" }
        expect(celdas(fila).destino.textContent).toBe("Wallets 2026")
    })

    it("deja el nombre si no es de ninguna wallet o es de una ajena", () => {
        expect(celdas({ ...FILA, walletDestino: "Binance" }).destino.textContent).toBe("Binance")
        fijarWallets([{ ...ETH, propia: false }])
        expect(celdas(FILA).destino.textContent).toBe("Wallets 2026")
    })

    it("sin datos no pinta nada", () => {
        const { origen, destino } = celdas({ ...FILA, walletDesde: "", walletDestino: "" })
        expect(origen.textContent).toBe("")
        expect(destino.textContent).toBe("")
    })

    it("escapa el texto de la fila", () => {
        const { destino } = celdas({ ...FILA, walletDestino: "<b>x</b>" })
        expect(destino.querySelector("b")).toBeNull()
        expect(destino.textContent).toBe("<b>x</b>")
    })
})

describe("abreviar", () => {
    it("no toca textos cortos ni con espacios", () => {
        expect(window.abreviarDireccionTransaccion("Ledger")).toBe("Ledger")
        expect(window.abreviarDireccionTransaccion("Un nombre con espacios bastante largo")).toBe(
            "Un nombre con espacios bastante largo"
        )
    })

    it("abrevia desde el largo de la dirección más corta", () => {
        const largo = "r".repeat(25)
        expect(window.abreviarDireccionTransaccion(largo)).toBe("rrrrrrrr…rrrr")
        expect(window.abreviarDireccionTransaccion(largo.slice(1))).toBe(largo.slice(1))
    })
})
