// Reparto de las baldosas del mapa de calor.
//
// El mapa se mira, no se lee: si una baldosa sale como una tira de veinte
// píxeles de ancho, el símbolo no cabe y esa parte de la cartera desaparece de
// la vista aunque el dato esté bien. Por eso lo que se comprueba aquí es la
// geometría —que estén todas, que no se pisen, que no se salgan y que sean más
// o menos cuadradas— y no el color, que es una función aparte.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

// Una cartera con la forma habitual: dos posiciones que pesan tanto como el
// resto juntas y una cola larga de posiciones pequeñas, que es justo el caso
// que el reparto anterior convertía en tiras.
const PESOS = [
    341.76, 236.49, 199.43, 171.74, 106.77, 101.75, 97.0, 93.34, 79.12, 72.94, 56.77, 27.29, 22.68, 20, 18, 16, 14, 12,
    11, 10, 9, 8, 7, 6, 5, 4, 3, 2.5, 2, 1.5
]

const ANCHO = 1560
const ALTO = 700

function repartir(pesos, w = ANCHO, h = ALTO) {
    const total = pesos.reduce((s, p) => s + p, 0)
    const items = pesos.map((p, i) => ({ id: `a${i}`, area: (p / total) * w * h }))
    return hmSquarify(items, 0, 0, w, h)
}

function proporcion(rect) {
    return Math.max(rect.w / rect.h, rect.h / rect.w)
}

beforeAll(() => {
    cargarScript("js/analisis/heatmap.js")
})

describe("hmSquarify", () => {
    it("coloca todos los activos una sola vez", () => {
        const rects = repartir(PESOS)

        expect(rects).toHaveLength(PESOS.length)
        expect(new Set(rects.map((r) => r.id)).size).toBe(PESOS.length)
    })

    it("llena el lienzo entero sin salirse", () => {
        const rects = repartir(PESOS)

        const pintado = rects.reduce((s, r) => s + r.w * r.h, 0)
        expect(pintado / (ANCHO * ALTO)).toBeCloseTo(1, 2)

        rects.forEach((r) => {
            expect(r.x).toBeGreaterThanOrEqual(-0.5)
            expect(r.y).toBeGreaterThanOrEqual(-0.5)
            expect(r.x + r.w).toBeLessThanOrEqual(ANCHO + 0.5)
            expect(r.y + r.h).toBeLessThanOrEqual(ALTO + 0.5)
        })
    })

    it("no solapa baldosas", () => {
        const rects = repartir(PESOS)

        const solapes = []
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const a = rects[i]
                const b = rects[j]
                const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
                const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
                if (ox > 0.5 && oy > 0.5) solapes.push([a.id, b.id])
            }
        }

        expect(solapes).toEqual([])
    })

    // El número no es sagrado, pero sí el orden de magnitud: el reparto por
    // mitades que había antes llegaba a 3,9 con estos mismos pesos.
    it("mantiene las baldosas cerca del cuadrado", () => {
        const rects = repartir(PESOS)

        const peor = Math.max(...rects.map(proporcion))
        expect(peor).toBeLessThan(2.5)
    })

    it("respeta el área de cada activo", () => {
        const pesos = [50, 30, 20]
        const rects = repartir(pesos, 600, 400)

        const total = 600 * 400
        pesos.forEach((peso, i) => {
            const rect = rects.find((r) => r.id === `a${i}`)
            expect((rect.w * rect.h) / total).toBeCloseTo(peso / 100, 2)
        })
    })

    it("aguanta los casos de borde sin romperse", () => {
        expect(hmSquarify([], 0, 0, 500, 300)).toEqual([])
        expect(hmSquarify([{ id: "x", area: 0 }], 0, 0, 500, 300)).toEqual([])

        const uno = hmSquarify([{ id: "x", area: 500 * 300 }], 0, 0, 500, 300)
        expect(uno).toHaveLength(1)
        expect(uno[0]).toMatchObject({ x: 0, y: 0 })

        // Un activo que se lo come todo y otro testimonial: el pequeño sigue
        // apareciendo, aunque sea con una baldosa mínima.
        const desigual = repartir([9999, 1], 800, 500)
        expect(desigual).toHaveLength(2)
        desigual.forEach((r) => {
            expect(r.w).toBeGreaterThan(0)
            expect(r.h).toBeGreaterThan(0)
        })
    })
})

describe("hmFontSize", () => {
    it("achica el cuerpo para que quepa el símbolo largo", () => {
        const corto = hmFontSize(200, 120, "KO")
        const largo = hmFontSize(200, 120, "NASDAQ100")

        expect(largo).toBeLessThan(corto)
        expect(largo).toBeGreaterThanOrEqual(9)
    })

    it("no se pasa del alto de la baldosa", () => {
        expect(hmFontSize(600, 40, "KO")).toBeLessThanOrEqual(40 * 0.4)
    })
})

describe("hmMovimiento", () => {
    // El dinero movido es la diferencia con lo que valía al empezar el periodo,
    // no el porcentaje aplicado al valor de ahora: ese porcentaje se calculó
    // sobre el precio de antes.
    it("descuenta sobre el valor del principio del periodo", () => {
        // 110 € tras un +10 % venían de 100 €: se han movido 10, no 11.
        expect(hmMovimiento(110, 10)).toBeCloseTo(10, 6)
        // 90 € tras un −10 % venían de 100 €: se han perdido 10, no 9.
        expect(hmMovimiento(90, -10)).toBeCloseTo(-10, 6)
    })

    it("apenas se distingue del cálculo directo con porcentajes pequeños", () => {
        expect(hmMovimiento(1000, 0.5)).toBeCloseTo(4.98, 2)
    })

    it("no inventa un movimiento cuando no hay dato", () => {
        expect(hmMovimiento(500, null)).toBeNull()
        expect(hmMovimiento(500, undefined)).toBeNull()
        expect(hmMovimiento(0, 12)).toBeNull()
        // Una caída del 100 % o más dejaría el valor de partida en cero o en
        // negativo: no hay nada que restar.
        expect(hmMovimiento(500, -100)).toBeNull()
        expect(hmMovimiento(500, -140)).toBeNull()
    })
})

describe("hmValorPeriodo", () => {
    const POSICION = { id: "btc", dia: -1.6, hasCuenta: true, cuentaPct: 13.2 }

    it("en «Todo» pinta el rendimiento desde la compra", () => {
        expect(hmValorPeriodo(POSICION, "todo")).toBe(13.2)
        // Sin invertido no hay rendimiento que enseñar.
        expect(hmValorPeriodo({ ...POSICION, hasCuenta: false }, "todo")).toBeNull()
    })

    it("en el resto de periodos usa el día o el histórico", () => {
        expect(hmValorPeriodo(POSICION, "dia")).toBe(-1.6)
        expect(hmValorPeriodo(POSICION, "mes", { btc: 4 })).toBe(4)
        expect(hmValorPeriodo(POSICION, "mes")).toBeNull()
    })

    it("el movimiento de «Todo» es valor actual menos invertido", () => {
        // 339,34 € de valor sobre 300,15 € invertidos.
        const pct = ((339.34 - 300.15) / 300.15) * 100
        expect(hmMovimiento(339.34, pct)).toBeCloseTo(39.19, 6)
    })
})
