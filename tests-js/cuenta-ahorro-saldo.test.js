// Ventana Cuenta de ahorro (js/finanzas/cuenta-ahorro.js): qué cuenta en el
// saldo y en el bloque de la cuenta bancaria.
//
// Lo delicado es cuadrar con el saldo del servidor: una mensualidad o un
// recurrente solo es de la bancaria si ese mes se cobra con ella, y lo que aún
// no ha llegado su día no suma.
import { beforeAll, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/dividendos.js")
    cargarScript("js/finanzas/cuenta-ahorro.js")
    runInThisContext('cuentaAhorroTodas = [{ id: "banco" }, { id: "ahorro" }, { id: "revolut" }]')
})

describe("cuentaAhorroCuentaDelMes", () => {
    it("la excepción del mes manda sobre la cuenta habitual", () => {
        const row = { cuenta: "", cuentasCobro: { abril: "revolut" } }

        expect(cuentaAhorroCuentaDelMes(row, "abril")).toBe("revolut")
        expect(cuentaAhorroCuentaDelMes(row, "mayo")).toBe("")
    })

    it("sin excepción es la habitual", () => {
        expect(cuentaAhorroCuentaDelMes({ cuenta: "ahorro" }, "enero")).toBe("ahorro")
    })
})

describe("cuentaAhorroEsBancaria", () => {
    it("vacío, la bancaria y una cuenta borrada son la bancaria", () => {
        expect(cuentaAhorroEsBancaria("")).toBe(true)
        expect(cuentaAhorroEsBancaria("banco")).toBe(true)
        expect(cuentaAhorroEsBancaria("borrada")).toBe(true)
    })

    it("otra cuenta que existe no lo es", () => {
        expect(cuentaAhorroEsBancaria("revolut")).toBe(false)
    })
})

describe("cuentaAhorroYaOcurrido", () => {
    const hoy = new Date(2026, 10, 21, 12)

    it("cuenta desde su día, o desde el 1 si no lo tiene", () => {
        expect(cuentaAhorroYaOcurrido({ year: "2026", month: 10, day: 21 }, hoy)).toBe(true)
        expect(cuentaAhorroYaOcurrido({ year: "2026", month: 10, day: 28 }, hoy)).toBe(false)
        expect(cuentaAhorroYaOcurrido({ year: "2026", month: 10, day: 0 }, hoy)).toBe(true)
        expect(cuentaAhorroYaOcurrido({ year: "2026", month: 11, day: 0 }, hoy)).toBe(false)
    })
})
