// La tasa de ahorro de Métricas no cuenta como gasto ni como ahorro las
// categorías que el usuario marca como inversión, con el mismo criterio que la página Ahorro
// (js/finanzas/ahorro-calculos.js). Sin esto, las dos páginas daban tasas
// distintas para los mismos datos.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/finanzas/ahorro-calculos.js")
    cargarModulo("js/analisis/metricas.js")
})

// Un año pasado: todas sus mensualidades cuentan.
const gastos2025 = {
    year: "2025",
    months: {
        enero: {
            rows: [
                { tipo: "Casa", cantidad: "700" },
                { tipo: "Inversion", cantidad: "300" }
            ]
        }
    },
    mensualidades: [{ categoria: "inversión", meses: { enero: "100" } }]
}
const ingresos2025 = { year: "2025", months: { enero: { rows: [{ cantidad: "2000" }] } }, recurrentes: [] }
const marcadas = { categoriasInversion: ["Inversion"] }

describe("inversión en Métricas", () => {
    it("mInversionDelMes suma filas y mensualidades de las categorías marcadas", () => {
        expect(mInversionDelMes(gastos2025, "enero", marcadas)).toBe(400)
        expect(mInversionDelMes(gastos2025, "febrero", marcadas)).toBe(0)
    })

    it("sin categorías marcadas no resta nada", () => {
        expect(mInversionDelMes(gastos2025, "enero")).toBe(0)
        expect(mInversionDelMes(gastos2025, "enero", { categoriasInversion: [] })).toBe(0)
    })

    it("el resumen anual no cuenta lo marcado ni como gasto ni como ahorro", () => {
        const datos = [{ year: "2025", gastosData: gastos2025, ingresosData: ingresos2025 }]
        const [conMarcadas] = mComputeResumenAnual(datos, marcadas)
        const [sinMarcadas] = mComputeResumenAnual(datos, {})

        expect(conMarcadas.gastado).toBe(700)
        expect(conMarcadas.invertido).toBe(400)
        // 2000 - 700 de gasto - 400 invertidos.
        expect(conMarcadas.ahorrado).toBe(900)
        expect(conMarcadas.tasa).toBe(45)
        expect(sinMarcadas.gastado).toBe(1100)
        expect(sinMarcadas.invertido).toBe(0)
        expect(sinMarcadas.ahorrado).toBe(900)
    })
})
