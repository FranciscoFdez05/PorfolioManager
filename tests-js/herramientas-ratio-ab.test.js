// Ratio entre dos activos: alineado por día y posición frente a su historia.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-ratio-ab.js")
})

const dia = (y, m, d) => Date.UTC(y, m - 1, d) / 1000

describe("hAbAlinear", () => {
    it("solo cruza los días con cierre en las dos series", () => {
        const a = [
            [dia(2024, 1, 6), 100], // sábado: solo cotiza A
            [dia(2024, 1, 8), 120],
            [dia(2024, 1, 5), 110]
        ]
        const b = [
            [dia(2024, 1, 5), 10],
            [dia(2024, 1, 8), 12]
        ]

        expect(hAbAlinear(a, b).map((p) => [p.dia, p.ratio])).toEqual([
            ["2024-01-05", 11],
            ["2024-01-08", 10]
        ])
    })

    it("descarta cierres no positivos", () => {
        expect(hAbAlinear([[dia(2024, 1, 5), 0]], [[dia(2024, 1, 5), 10]])).toEqual([])
    })
})

describe("hAbRecortar", () => {
    it("cuenta los años desde el último dato", () => {
        const puntos = [2019, 2021, 2022, 2023, 2024].map((y) => ({ ts: Date.UTC(y, 5, 1) }))

        expect(hAbRecortar(puntos, 2)).toHaveLength(3)
        expect(hAbRecortar(puntos, 0)).toHaveLength(5)
    })
})

describe("hAbEstadisticas", () => {
    const puntos = [1, 2, 3, 4, 5].map((ratio) => ({ ratio }))

    it("compara el último ratio con su historia", () => {
        const e = hAbEstadisticas(puntos)

        expect(e.actual).toBe(5)
        expect(e.media).toBe(3)
        expect(e.mediana).toBe(3)
        expect(e.minimo).toBe(1)
        expect(e.maximo).toBe(5)
        expect(e.percentil).toBeCloseTo(0.8, 10)
        // Desviación muestral de 1..5 = √2,5.
        expect(e.z).toBeCloseTo(2 / Math.sqrt(2.5), 10)
    })

    it("sin dispersión no hay z", () => {
        expect(hAbEstadisticas([{ ratio: 2 }, { ratio: 2 }]).z).toBeNull()
    })

    it("necesita al menos dos puntos", () => {
        expect(hAbEstadisticas([{ ratio: 1 }])).toBeNull()
    })
})
