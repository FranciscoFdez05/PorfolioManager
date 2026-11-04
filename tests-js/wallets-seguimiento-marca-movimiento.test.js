// Detalle de un movimiento: una transacción se marca «entre mis wallets» para que
// lo comprado en un exchange y pasado a la wallet no cuente dos veces. La comisión
// se propone donde la de la red sirve (no en Bitcoin ni en tokens).
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const PROPIA_ETH = { id: "w-eth", red: "eth", propia: true }
const PROPIA_BTC = { id: "w-btc", red: "btc", propia: true }
const AJENA = { id: "w-otra", red: "eth", propia: false }
const RECIBIDA = { hash: "0xabc", simbolo: "ETH", tipo: "recibida", sentido: "recibida", comision: "", comisionLeida: "", comisionTx: "0.00002" }

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarScript("js/cripto/wallets-seguimiento.js")
})

describe("comisión propuesta", () => {
    it("en ETH propone la de la red aunque la pagara el exchange", () => {
        expect(window.walletsSegComisionPropuesta(RECIBIDA, PROPIA_ETH)).toBe("0.00002")
    })

    it("en BTC sale vacía: es la de todo el lote del exchange", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, simbolo: "BTC" }, PROPIA_BTC)).toBe("")
    })

    it("en un token sale vacía: la de la red se paga en otra moneda", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, simbolo: "USDC", contrato: "0xusdc" }, PROPIA_ETH)).toBe("")
    })

    it("respeta la que el usuario ya puso y la que pagó esta wallet", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, comisionMarcada: "0.0005" }, PROPIA_ETH)).toBe("0.0005")
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, comisionLeida: "0.001" }, PROPIA_BTC)).toBe("0.001")
    })
})

describe("sección de la transacción", () => {
    it("no sale en una wallet ajena ni en un movimiento entre sus direcciones", () => {
        expect(window.walletsSegMarcaMovimientoHtml(RECIBIDA, AJENA)).toBe("")
        expect(window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, tipo: "entre_wallet", sentido: "entre_wallet" }, PROPIA_ETH)).toBe("")
    })

    it("ofrece entre mis wallets o lo que leyó la red", () => {
        const html = window.walletsSegMarcaMovimientoHtml(RECIBIDA, PROPIA_ETH)
        expect(html).toContain("Entre mis wallets")
        expect(html).toContain("Recibida")
        expect(html).not.toContain("Quitar marca")
    })

    it("con marca se puede quitar", () => {
        expect(window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, marcaMovimiento: "propia" }, PROPIA_ETH)).toContain("Quitar marca")
    })

    it("en Bitcoin avisa del cambio", () => {
        expect(window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, simbolo: "BTC" }, PROPIA_BTC)).toContain("xpub")
        expect(window.walletsSegMarcaMovimientoHtml(RECIBIDA, PROPIA_ETH)).not.toContain("xpub")
    })
})

describe("aplicar la marca", () => {
    it("entre mis wallets cambia el tipo y la comisión, y se deshace", () => {
        const mov = { ...RECIBIDA }

        window.walletsSegConMarca(mov, { propia: true, comision: "0.0005" })
        expect([mov.tipo, mov.sentido, mov.comision]).toEqual(["entre_wallet", "recibida", "0.0005"])

        window.walletsSegConMarca(mov, null)
        expect([mov.tipo, mov.comision, mov.marcaMovimiento]).toEqual(["recibida", "", ""])
    })

    it("la marca manda sobre la de su dirección", () => {
        const mov = { ...RECIBIDA, tipo: "entre_wallet", contraparteMarca: "propia" }

        window.walletsSegConMarca(mov, { propia: false, comision: "" })
        expect(mov.tipo).toBe("recibida")

        window.walletsSegConMarca(mov, null)
        expect(mov.tipo).toBe("entre_wallet")
    })
})
