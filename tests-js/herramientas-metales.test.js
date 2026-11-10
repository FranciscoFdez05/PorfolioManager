// Calculadora de oro y plata: conversión de unidades y valor del metal fino.
//
// El precio se cotiza por onza troy (31,1034768 g). Confundirla con la onza
// común (28,35 g) o con el gramo daría valores un 10 % o 31 veces desviados, así
// que es lo que se fija aquí.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-metales.js")
})

describe("hMetAGramos", () => {
    it("convierte gramos, kilos y onzas troy", () => {
        expect(hMetAGramos(5, "g")).toBe(5)
        expect(hMetAGramos(1.5, "kg")).toBe(1500)
        expect(hMetAGramos(2, "oz")).toBeCloseTo(62.2069536, 10)
    })

    it("devuelve NaN con una unidad desconocida", () => {
        expect(hMetAGramos(1, "lb")).toBeNaN()
    })
})

describe("hMetCalcularValor", () => {
    it("una onza troy pura vale exactamente el precio de la onza", () => {
        const r = hMetCalcularValor({ cantidad: 1, unidad: "oz", ley: 1000, precioOnza: 2500 })

        expect(r.valor).toBeCloseTo(2500, 10)
        expect(r.onzasFinas).toBeCloseTo(1, 12)
        expect(r.gramosFinos).toBeCloseTo(31.1034768, 10)
    })

    it("un kilo puro son 32,1507 onzas troy", () => {
        const r = hMetCalcularValor({ cantidad: 1, unidad: "kg", ley: 1000, precioOnza: 100 })

        expect(r.onzasFinas).toBeCloseTo(32.1507466, 6)
        expect(r.valor).toBeCloseTo(3215.07466, 4)
        expect(r.precioKilo).toBeCloseTo(r.valor, 10)
    })

    it("la ley reduce el metal fino: 100 g de 18 k son 75 g de oro", () => {
        const r = hMetCalcularValor({ cantidad: 100, unidad: "g", ley: 750, precioOnza: 3110.34768 })

        expect(r.gramosFinos).toBeCloseTo(75, 10)
        expect(r.precioGramo).toBeCloseTo(100, 10)
        expect(r.valor).toBeCloseTo(7500, 8)
    })

    it.each([
        ["cantidad cero", { cantidad: 0, unidad: "g", ley: 1000, precioOnza: 100 }],
        ["cantidad negativa", { cantidad: -1, unidad: "g", ley: 1000, precioOnza: 100 }],
        ["cantidad vacía", { cantidad: NaN, unidad: "g", ley: 1000, precioOnza: 100 }],
        ["unidad desconocida", { cantidad: 1, unidad: "lb", ley: 1000, precioOnza: 100 }],
        ["ley cero", { cantidad: 1, unidad: "g", ley: 0, precioOnza: 100 }],
        ["ley por encima de 1000", { cantidad: 1, unidad: "g", ley: 1001, precioOnza: 100 }],
        ["sin precio", { cantidad: 1, unidad: "g", ley: 1000, precioOnza: NaN }]
    ])("devuelve null con %s", (_caso, datos) => {
        expect(hMetCalcularValor(datos)).toBeNull()
    })
})

describe("hMetCalcularCantidad", () => {
    it("el precio de una onza compra una onza troy pura", () => {
        const r = hMetCalcularCantidad({ importe: 2500, unidad: "oz", ley: 1000, precioOnza: 2500 })

        expect(r.cantidad).toBeCloseTo(1, 12)
        expect(r.gramosFinos).toBeCloseTo(31.1034768, 10)
        expect(r.valor).toBeCloseTo(2500, 10)
    })

    it("devuelve la cantidad en la unidad pedida", () => {
        const datos = { importe: 1000, ley: 1000, precioOnza: 3110.34768 }

        expect(hMetCalcularCantidad({ ...datos, unidad: "g" }).cantidad).toBeCloseTo(10, 10)
        expect(hMetCalcularCantidad({ ...datos, unidad: "kg" }).cantidad).toBeCloseTo(0.01, 12)
        expect(hMetCalcularCantidad({ ...datos, unidad: "oz" }).cantidad).toBeCloseTo(10 / 31.1034768, 12)
    })

    it("con ley 750 la pieza pesa más para contener el mismo oro fino", () => {
        const r = hMetCalcularCantidad({ importe: 7500, unidad: "g", ley: 750, precioOnza: 3110.34768 })

        expect(r.gramosFinos).toBeCloseTo(75, 10)
        expect(r.cantidad).toBeCloseTo(100, 10)
    })

    it("es la inversa de hMetCalcularValor", () => {
        const datos = { unidad: "kg", ley: 916, precioOnza: 3634.47 }
        const valor = hMetCalcularValor({ ...datos, cantidad: 0.25 }).valor

        expect(hMetCalcularCantidad({ ...datos, importe: valor }).cantidad).toBeCloseTo(0.25, 12)
    })

    it.each([
        ["importe cero", { importe: 0, unidad: "g", ley: 1000, precioOnza: 100 }],
        ["importe negativo", { importe: -5, unidad: "g", ley: 1000, precioOnza: 100 }],
        ["importe vacío", { importe: NaN, unidad: "g", ley: 1000, precioOnza: 100 }],
        ["unidad desconocida", { importe: 100, unidad: "lb", ley: 1000, precioOnza: 100 }],
        ["ley cero", { importe: 100, unidad: "g", ley: 0, precioOnza: 100 }],
        ["ley por encima de 1000", { importe: 100, unidad: "g", ley: 1001, precioOnza: 100 }],
        ["sin precio", { importe: 100, unidad: "g", ley: 1000, precioOnza: NaN }]
    ])("devuelve null con %s", (_caso, datos) => {
        expect(hMetCalcularCantidad(datos)).toBeNull()
    })
})

describe("H_MET_PUREZAS", () => {
    it.each(["oro", "plata"])("%s empieza por el metal puro y baja de pureza", (metal) => {
        const leyes = H_MET_PUREZAS[metal].map((p) => p.ley)

        expect(leyes[0]).toBe(1000)
        leyes.forEach((ley, i) => {
            expect(ley).toBeGreaterThan(0)
            if (i > 0) expect(ley).toBeLessThan(leyes[i - 1])
        })
    })

    it("hay purezas para cada metal con precio", () => {
        expect(Object.keys(H_MET_PUREZAS).sort()).toEqual(Object.keys(H_MET_METALES).sort())
    })
})
