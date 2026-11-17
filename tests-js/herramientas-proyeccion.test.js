// Herramientas de proyección: FIRE, desacumulación, Monte Carlo y rentabilidad real.
//
// Lo que se fija aquí son los casos que se pueden comprobar a mano (rentabilidad
// cero, volatilidad cero, renta perpetua) y que Monte Carlo, con semilla, es
// reproducible y su media converge a la rentabilidad pedida.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-proyeccion.js")
})

describe("hFireCalcular", () => {
    const base = { gastosAnuales: 24000, tasaRetirada: 4, patrimonio: 0, aportacionMensual: 1000, rentabilidad: 0 }

    it("el objetivo es gastos entre tasa de retirada", () => {
        expect(hFireCalcular(base).objetivo).toBeCloseTo(600000, 6)
    })

    it("sin rentabilidad se llega aportando el objetivo entero", () => {
        const r = hFireCalcular({ ...base, gastosAnuales: 480 })

        // 12.000 € a 1.000 € al mes.
        expect(r.meses).toBe(12)
        expect(r.serie.at(-1).valor).toBeCloseTo(12000, 6)
    })

    it("con el objetivo ya cubierto el tiempo es cero", () => {
        const r = hFireCalcular({ ...base, patrimonio: 700000 })

        expect(r.meses).toBe(0)
        expect(r.progreso).toBe(1)
        expect(r.falta).toBe(0)
    })

    it("sin aportar ni rentar no se llega nunca", () => {
        expect(hFireCalcular({ ...base, aportacionMensual: 0, patrimonio: 1000 }).meses).toBeNull()
    })

    it.each([{ gastosAnuales: 0 }, { tasaRetirada: 0 }, { patrimonio: -1 }, { rentabilidad: NaN }])(
        "rechaza datos no válidos (%o)",
        (cambio) => {
            expect(hFireCalcular({ ...base, ...cambio })).toBeNull()
        }
    )
})

describe("hDesCalcular", () => {
    it("sin rentabilidad ni inflación dura capital entre retirada", () => {
        const r = hDesCalcular({ capital: 100, retiradaAnual: 10, rentabilidad: 0, inflacion: 0 })

        expect(r.anos).toBe(10)
        expect(r.totalRetirado).toBeCloseTo(100, 10)
        expect(r.retiradaSostenible).toBeNull()
    })

    it("el último año incompleto cuenta en proporción", () => {
        const r = hDesCalcular({ capital: 25, retiradaAnual: 10, rentabilidad: 0, inflacion: 0 })

        expect(r.anos).toBeCloseTo(2.5, 10)
    })

    it("la retirada sostenible mantiene el capital indefinidamente", () => {
        const sostenible = hDesCalcular({ capital: 1000, retiradaAnual: 1, rentabilidad: 5, inflacion: 0 })
            .retiradaSostenible
        const r = hDesCalcular({ capital: 1000, retiradaAnual: sostenible, rentabilidad: 5, inflacion: 0 })

        expect(sostenible).toBeCloseTo(47.619, 3)
        expect(r.anos).toBeNull()
        expect(r.capitalFinal).toBeCloseTo(1000, 6)
    })

    it("la inflación sube la retirada cada año", () => {
        const sin = hDesCalcular({ capital: 1000, retiradaAnual: 100, rentabilidad: 0, inflacion: 0 })
        const con = hDesCalcular({ capital: 1000, retiradaAnual: 100, rentabilidad: 0, inflacion: 10 })

        expect(con.anos).toBeLessThan(sin.anos)
    })

    it("pide la inflación: sin ella no calcula", () => {
        expect(hDesCalcular({ capital: 1000, retiradaAnual: 100, rentabilidad: 5, inflacion: NaN })).toBeNull()
    })
})

describe("hMcPercentil", () => {
    it("interpola entre posiciones", () => {
        expect(hMcPercentil([1, 2, 3, 4], 0.5)).toBe(2.5)
        expect(hMcPercentil([1, 2, 3, 4], 0)).toBe(1)
        expect(hMcPercentil([1, 2, 3, 4], 1)).toBe(4)
    })
})

describe("hMcSimular", () => {
    const base = {
        capital: 1000,
        aportacionMensual: 0,
        rentabilidad: 7,
        volatilidad: 20,
        anos: 10,
        simulaciones: 5000,
        semilla: 42
    }

    it("con volatilidad cero todas las trayectorias son la compuesta", () => {
        const r = hMcSimular({ ...base, rentabilidad: 10, volatilidad: 0, anos: 1, simulaciones: 50 })

        expect(r.final.p10).toBeCloseTo(1100, 6)
        expect(r.final.p50).toBeCloseTo(1100, 6)
        expect(r.final.p90).toBeCloseTo(1100, 6)
        expect(r.probPerdida).toBe(0)
    })

    it("la media converge a la rentabilidad pedida", () => {
        const r = hMcSimular(base)

        expect(r.final.media / (1000 * Math.pow(1.07, 10))).toBeGreaterThan(0.95)
        expect(r.final.media / (1000 * Math.pow(1.07, 10))).toBeLessThan(1.05)
    })

    it("los percentiles quedan ordenados y la mediana bajo la media", () => {
        const r = hMcSimular(base)

        expect(r.final.p10).toBeLessThan(r.final.p50)
        expect(r.final.p50).toBeLessThan(r.final.p90)
        // Una lognormal tiene la mediana por debajo de la media.
        expect(r.final.p50).toBeLessThan(r.final.media)
        expect(r.anual).toHaveLength(11)
    })

    it("con la misma semilla da el mismo resultado", () => {
        expect(hMcSimular(base).final).toEqual(hMcSimular(base).final)
    })

    it("cuenta las aportaciones en lo aportado", () => {
        expect(hMcSimular({ ...base, aportacionMensual: 100 }).totalAportado).toBe(1000 + 100 * 12 * 10)
    })

    it.each([{ anos: 0 }, { anos: 1.5 }, { simulaciones: 5 }, { volatilidad: -1 }, { capital: 0 }])(
        "rechaza datos no válidos (%o)",
        (cambio) => {
            expect(hMcSimular({ ...base, ...cambio })).toBeNull()
        }
    )
})

describe("hRealCalcular", () => {
    const base = { nominal: 3, inflacion: 2, impuesto: 19, capital: 10000, anos: 1 }

    it("aplica Fisher después de impuestos", () => {
        const r = hRealCalcular(base)

        expect(r.nominalNeta).toBeCloseTo(0.0243, 10)
        expect(r.realBruta).toBeCloseTo(1.03 / 1.02 - 1, 10)
        expect(r.realNeta).toBeCloseTo(1.0243 / 1.02 - 1, 10)
        expect(r.capitalReal).toBeCloseTo(10243 / 1.02, 6)
    })

    it("una pérdida no paga impuesto", () => {
        expect(hRealCalcular({ ...base, nominal: -2 }).nominalNeta).toBeCloseTo(-0.02, 10)
    })

    it("pide la inflación: sin ella no calcula", () => {
        expect(hRealCalcular({ ...base, inflacion: NaN })).toBeNull()
    })
})
