// Una fila «entre wallets» no mueve la cantidad, pero su comisión sí sale de la
// posición de la cripto.
import { beforeAll, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

const fijarFilas = (filas) => {
    window.__filasPrueba = filas
    runInThisContext("externalTransaccionesRowsCache = window.__filasPrueba")
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets.js")
})

describe("impacto de las transacciones en la posición", () => {
    it("entre wallets resta solo la comisión", () => {
        fijarFilas([{ assetId: "bitcoin", walletTipo: "entre_wallet", total: "0.01355828", comisionRed: "0.00000413" }])

        const impacto = window.getTransaccionesCryptoImpact({ id: "bitcoin" })

        expect(impacto.quantityDelta).toBeCloseTo(-0.00000413, 10)
        expect(impacto.commissionTotal).toBeCloseTo(0.00000413, 10)
    })

    it("sin comisión no cambia la posición", () => {
        fijarFilas([{ assetId: "bitcoin", walletTipo: "entre_wallet", total: "0.01355828", comisionRed: "" }])

        expect(window.getTransaccionesCryptoImpact({ id: "bitcoin" }).quantityDelta).toBe(0)
    })
})
