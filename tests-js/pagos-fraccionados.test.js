// Pruebas de la página de pagos fraccionados (js/finanzas/pagos-fraccionados.js).
//
// Junta el gasto propio, su fila «parte de otros» y las devoluciones que
// llegaron como ingresos. Si el emparejado falla, la página enseña pagos
// con el estado de devolución equivocado.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/pagos-fraccionados.js")
})

const gastosMarzo = (filas) => ({ marzo: { rows: filas } })
const ingresosMarzo = (filas) => ({ marzo: { rows: filas } })

const propia = { fecha: "05-03-2026", nombre: "Cena", tipo: "Comidas", cantidad: "30,00 €", cuenta: "", nota: "" }
const otros = {
    fecha: "05-03-2026",
    nombre: "Cena (parte de otros)",
    tipo: "Pagos fraccionados",
    cantidad: "60,00 €",
    cuenta: "",
    nota: ""
}
const devolucion = (persona, cantidad) => ({
    fecha: "05-03-2026",
    nombre: `Devolución: Cena (${persona})`,
    tipo: "Pagos fraccionados",
    cantidad,
    cuenta: "bitvavo"
})

describe("construirPagosFraccionados", () => {
    it("calcula total, tu parte y lo devuelto", () => {
        const [pago] = construirPagosFraccionados(gastosMarzo([propia, otros]), ingresosMarzo([]))
        expect(pago).toMatchObject({ total: 9000, parte: 3000, devuelto: 6000, mes: "marzo" })
    })

    it("un gasto normal no es un pago fraccionado", () => {
        expect(construirPagosFraccionados(gastosMarzo([propia]), {})).toEqual([])
    })

    it("una fila «parte de otros» sin fila propia no aparece", () => {
        expect(construirPagosFraccionados(gastosMarzo([otros]), {})).toEqual([])
    })

    it("sin devoluciones registradas queda todo pendiente", () => {
        const [pago] = construirPagosFraccionados(gastosMarzo([propia, otros]), {})
        expect(pago.recibido).toBe(0)
        expect(pago.pendiente).toBe(6000)
    })

    it("con todas las devoluciones no queda nada pendiente", () => {
        const ingresos = ingresosMarzo([devolucion("Ana", "30,00 €"), devolucion("Luis", "30,00 €")])
        const [pago] = construirPagosFraccionados(gastosMarzo([propia, otros]), ingresos)
        expect(pago.devoluciones.map((d) => d.nombre)).toEqual(["Ana", "Luis"])
        expect(pago.recibido).toBe(6000)
        expect(pago.pendiente).toBe(0)
    })

    it("una devolución parcial deja la diferencia pendiente", () => {
        const [pago] = construirPagosFraccionados(gastosMarzo([propia, otros]), ingresosMarzo([devolucion("Ana", "30,00 €")]))
        expect(pago.pendiente).toBe(3000)
    })

    it("ignora devoluciones de otro concepto o de otra fecha", () => {
        const ajena = { ...devolucion("Ana", "30,00 €"), nombre: "Devolución: Taxi (Ana)" }
        const otraFecha = { ...devolucion("Ana", "30,00 €"), fecha: "06-03-2026" }
        const [pago] = construirPagosFraccionados(gastosMarzo([propia, otros]), ingresosMarzo([ajena, otraFecha]))
        expect(pago.devoluciones).toEqual([])
    })

    it("tolera años sin meses", () => {
        expect(construirPagosFraccionados(undefined, undefined)).toEqual([])
    })
})

describe("totalizarPagosFraccionados", () => {
    it("suma los pagos y devuelve ceros si no hay ninguno", () => {
        expect(totalizarPagosFraccionados([])).toEqual({ total: 0, parte: 0, devuelto: 0, pendiente: 0 })
        const pagos = construirPagosFraccionados(gastosMarzo([propia, otros]), {})
        expect(totalizarPagosFraccionados([...pagos, ...pagos])).toEqual({
            total: 18000,
            parte: 6000,
            devuelto: 12000,
            pendiente: 12000
        })
    })
})
