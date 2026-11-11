// Pruebas de los consejos de presupuesto (js/finanzas/ahorro-consejos.js):
// pautas genéricas de la regla 50/30/20, su equivalencia en euros y el aviso
// sobre el objetivo de ahorro. No dependen de las categorías del usuario.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/ahorro-calculos.js")
    cargarScript("js/finanzas/ahorro-consejos.js")
})

const K = () => AhorroConsejos

describe("pautas genéricas", () => {
    it("cada pauta tiene un rango válido y pertenece a necesidades o deseos", () => {
        for (const p of K().PAUTAS) {
            expect(p.min).toBeGreaterThan(0)
            expect(p.max).toBeGreaterThanOrEqual(p.min)
            expect(["necesidad", "deseo"]).toContain(p.tipo)
        }
    })

    it("los mínimos de cada grupo caben en su tope de la regla 50/30/20", () => {
        const { grupos } = K().consejos({ ingresos: 0, objetivo: 20 })
        for (const g of grupos) {
            expect(g.pautas.reduce((s, p) => s + p.min, 0)).toBeLessThanOrEqual(g.tope)
        }
        expect(grupos.map((g) => g.tope)).toEqual([50, 30])
        expect(K().AHORRO_RECOMENDADO).toBe(20)
    })

    it("agrupa todas las pautas sin perder ninguna", () => {
        const { grupos } = K().consejos({ ingresos: 1000, objetivo: 20 })
        expect(grupos.flatMap((g) => g.pautas)).toHaveLength(K().PAUTAS.length)
    })
})

describe("equivalencia en euros", () => {
    it("convierte rangos y topes con los ingresos medios", () => {
        const { grupos } = K().consejos({ ingresos: 1000, objetivo: 30 })
        const vivienda = grupos[0].pautas.find((p) => p.nombre === "Vivienda")
        expect(vivienda).toMatchObject({ minEur: 200, maxEur: 300 })
        expect(grupos[0].topeEur).toBe(500)
        expect(grupos[1].topeEur).toBe(300)
    })

    it("sin ingresos no inventa euros", () => {
        const { grupos } = K().consejos({ ingresos: 0, objetivo: 30 })
        expect(grupos[0].topeEur).toBeNull()
        expect(grupos[0].pautas[0]).toMatchObject({ minEur: null, maxEur: null })
    })
})

describe("aviso del objetivo de ahorro", () => {
    it("avisa si el objetivo queda por debajo del 20 %", () => {
        expect(K().consejos({ ingresos: 1000, objetivo: 10 }).aviso.tono).toBe("neg")
    })

    it("confirma un objetivo del 20 % o más", () => {
        expect(K().consejos({ ingresos: 1000, objetivo: 20 }).aviso.tono).toBe("pos")
    })

    it("sin objetivo escrito no hay aviso", () => {
        expect(K().consejos({ ingresos: 1000, objetivo: NaN }).aviso).toBeNull()
    })
})
