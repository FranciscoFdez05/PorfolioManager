// Herramientas de cartera: tamaño de posición, recuperación tras caída y DCA.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-cartera.js")
})

describe("hTpCalcular", () => {
    const base = { capital: 10000, riesgoPct: 1, entrada: 100, stop: 92 }

    it("reparte el riesgo entre la distancia al stop", () => {
        const r = hTpCalcular(base)

        // 100 € de riesgo / 8 € por unidad.
        expect(r.riesgo).toBe(100)
        expect(r.unidades).toBeCloseTo(12.5, 10)
        expect(r.unidadesEnteras).toBe(12)
        expect(r.importe).toBeCloseTo(1250, 10)
        expect(r.peso).toBeCloseTo(0.125, 10)
        expect(r.corto).toBe(false)
    })

    it("la comisión se descuenta del riesgo", () => {
        expect(hTpCalcular({ ...base, comision: 20 }).unidades).toBeCloseTo(10, 10)
    })

    it("un stop por encima de la entrada es un corto", () => {
        const r = hTpCalcular({ ...base, stop: 108, objetivo: 84 })

        expect(r.corto).toBe(true)
        expect(r.unidades).toBeCloseTo(12.5, 10)
        expect(r.ratio).toBeCloseTo(2, 10)
    })

    it("el ratio solo cuenta con un objetivo del lado de la ganancia", () => {
        expect(hTpCalcular({ ...base, objetivo: 124 }).ratio).toBeCloseTo(3, 10)
        expect(hTpCalcular({ ...base, objetivo: 90 }).ratio).toBeNull()
    })

    it.each([{ stop: 100 }, { entrada: 0 }, { riesgoPct: 0 }, { comision: 150 }])(
        "rechaza datos no válidos (%o)",
        (cambio) => {
            expect(hTpCalcular({ ...base, ...cambio })).toBeNull()
        }
    )
})

describe("hRecCalcular", () => {
    it("un −50 % pide un +100 %", () => {
        expect(hRecCalcular({ caida: 50 }).subida).toBeCloseTo(1, 10)
    })

    it("las comisiones también hay que recuperarlas", () => {
        expect(hRecCalcular({ caida: 50, comision: 1 }).subida).toBeCloseTo(1 / (0.5 * 0.99) - 1, 10)
    })

    it("estima los años con la rentabilidad compuesta", () => {
        // Doblar al 7 % lleva ln 2 / ln 1,07 años.
        expect(hRecCalcular({ caida: 50, rentabilidad: 7 }).anos).toBeCloseTo(Math.log(2) / Math.log(1.07), 10)
        expect(hRecCalcular({ caida: 50, rentabilidad: 0 }).anos).toBeNull()
    })

    it("rechaza una caída del 100 % o más", () => {
        expect(hRecCalcular({ caida: 100 })).toBeNull()
    })
})

describe("hDcaMensual", () => {
    it("toma el primer cierre de cada mes, en orden y con ts en segundos", () => {
        const dia = (y, m, d) => Date.UTC(y, m - 1, d) / 1000
        const serie = hDcaMensual([
            [dia(2024, 2, 1), 20],
            [dia(2024, 1, 15), 11],
            [dia(2024, 1, 2), 10],
            [dia(2024, 2, 20), 25],
            [dia(2024, 3, 4), 0]
        ])

        expect(serie.map((p) => [p.mes, p.precio])).toEqual([
            ["2024-01", 10],
            ["2024-02", 20]
        ])
    })
})

describe("hDcaSimular", () => {
    const serie = [10, 5, 10, 20].map((precio, i) => ({ mes: `2024-0${i + 1}`, precio }))

    it("compra todo al principio o en partes iguales", () => {
        const r = hDcaSimular(serie, { importe: 300, meses: 3, inicio: 0 })

        // Único: 30 unidades. DCA: 10 + 20 + 10 = 40 unidades.
        expect(r.at(-1).unico).toBeCloseTo(600, 10)
        expect(r.at(-1).dca).toBeCloseTo(800, 10)
        expect(r.map((p) => p.aportado)).toEqual([100, 200, 300, 300])
    })

    it("no deja empezar donde no caben las aportaciones", () => {
        expect(hDcaSimular(serie, { importe: 300, meses: 3, inicio: 2 })).toBeNull()
    })
})

describe("hDcaVentanas", () => {
    it("en una serie que solo sube siempre gana todo de golpe", () => {
        const serie = Array.from({ length: 24 }, (_, i) => ({ mes: String(i), precio: 100 * 1.01 ** i }))
        const r = hDcaVentanas(serie, 12)

        expect(r.ventanas).toBe(13)
        expect(r.ganaUnico).toBe(13)
        expect(r.diferenciaMedia).toBeGreaterThan(0)
    })

    it("en una serie que solo baja siempre gana repartir", () => {
        const serie = Array.from({ length: 24 }, (_, i) => ({ mes: String(i), precio: 100 * 0.99 ** i }))

        expect(hDcaVentanas(serie, 12).ganaUnico).toBe(0)
    })

    it("pide al menos dos meses y una serie que los cubra", () => {
        expect(hDcaVentanas([{ mes: "a", precio: 1 }], 12)).toBeNull()
        expect(hDcaVentanas([{ mes: "a", precio: 1 }], 1)).toBeNull()
    })
})
