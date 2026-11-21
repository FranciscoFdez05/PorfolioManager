// Herramientas › Simular compra: precio medio, posición y peso tras comprar.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-compra.js")
})

describe("hScUnidades", () => {
    it("divide lo invertido entre el precio", () => {
        expect(hScUnidades(500, 125)).toBe(4)
    })

    it("admite fracciones, como en cripto", () => {
        expect(hScUnidades(100, 80000)).toBeCloseTo(0.00125, 12)
    })

    it.each([
        [0, 100],
        [100, 0],
        [-5, 100],
        [NaN, 100]
    ])("sin importe o precio positivos no hay unidades (%s, %s)", (importe, precio) => {
        expect(hScUnidades(importe, precio)).toBeNaN()
    })
})

describe("hScCalcular", () => {
    const base = {
        unidades: 10,
        invertido: 1000,
        precioMercado: 80,
        precioCompra: 80,
        unidadesCompra: 10,
        totalCarteraEur: 4000
    }

    it("promedia a la baja comprando por debajo del medio", () => {
        const r = hScCalcular(base)

        expect(r.importe).toBe(800)
        expect(r.unidadesDespues).toBe(20)
        expect(r.invertidoDespues).toBe(1800)
        expect(r.medioAntes).toBe(100)
        expect(r.medioDespues).toBe(90)
        expect(r.variacionMedio).toBeCloseTo(-0.1, 12)
    })

    it("mide el peso antes y después con la compra como dinero nuevo", () => {
        const r = hScCalcular(base)

        // Antes: 800 de 4000. Después: 1600 de 4800.
        expect(r.pesoAntes).toBeCloseTo(0.2, 12)
        expect(r.pesoDespues).toBeCloseTo(1600 / 4800, 12)
        expect(r.totalDespuesEur).toBe(4800)
    })

    it("da el peso de la compra dentro de la posición, por coste y por unidades", () => {
        const r = hScCalcular({ ...base, precioCompra: 50, unidadesCompra: 10 })

        // 500 de 1500 invertidos; 10 de 20 unidades.
        expect(r.pesoCompraCoste).toBeCloseTo(1 / 3, 12)
        expect(r.pesoCompraUnidades).toBe(0.5)
    })

    it("en una posición nueva la compra es toda la posición", () => {
        const r = hScCalcular({ precioCompra: 50, unidadesCompra: 4 })

        expect(r.pesoCompraCoste).toBe(1)
        expect(r.pesoCompraUnidades).toBe(1)
    })

    it("la rentabilidad latente se valora a precio de mercado", () => {
        const r = hScCalcular(base)

        expect(r.rentAntes).toBe(-200)
        expect(r.rentAntesPct).toBeCloseTo(-0.2, 12)
        expect(r.rentDespues).toBe(-200)
        expect(r.rentDespuesPct).toBeCloseTo(-200 / 1800, 12)
    })

    it("un precio de compra distinto del de mercado cambia el medio pero no el valor", () => {
        const r = hScCalcular({ ...base, precioCompra: 70, unidadesCompra: 10 })

        expect(r.medioDespues).toBe(85)
        expect(r.valorDespues).toBe(1600)
        expect(r.rentDespues).toBe(1600 - 1700)
    })

    it("sin posición previa abre una nueva", () => {
        const r = hScCalcular({ precioCompra: 50, unidadesCompra: 4, precioMercado: 50, totalCarteraEur: 800 })

        expect(r.medioAntes).toBeNull()
        expect(r.variacionMedio).toBeNull()
        expect(r.rentAntes).toBeNull()
        expect(r.rentAntesPct).toBeNull()
        expect(r.medioDespues).toBe(50)
        expect(r.pesoAntes).toBe(0)
        expect(r.pesoDespues).toBeCloseTo(200 / 1000, 12)
    })

    it("con la cartera vacía, la compra es el 100 %", () => {
        const r = hScCalcular({ precioCompra: 10, unidadesCompra: 3 })

        expect(r.pesoAntes).toBe(0)
        expect(r.pesoDespues).toBe(1)
    })

    it("sin precio de mercado valora al de compra", () => {
        const r = hScCalcular({ ...base, precioMercado: NaN, precioCompra: 120 })

        expect(r.valorDespues).toBe(20 * 120)
    })

    it("convierte a euros solo para el peso", () => {
        // 10 uds a 100 USD con 0,9 €/USD valen 900 € de una cartera de 1800 €.
        const r = hScCalcular({
            unidades: 10,
            invertido: 1000,
            precioMercado: 100,
            precioCompra: 100,
            unidadesCompra: 10,
            fx: 0.9,
            totalCarteraEur: 1800
        })

        expect(r.medioDespues).toBe(100)
        expect(r.pesoAntes).toBeCloseTo(0.5, 12)
        expect(r.totalDespuesEur).toBeCloseTo(2700, 9)
        expect(r.pesoDespues).toBeCloseTo(1800 / 2700, 12)
    })

    it("un total escrito menor que la posición no da pesos por encima del 100 %", () => {
        const r = hScCalcular({ ...base, totalCarteraEur: 100 })

        expect(r.pesoAntes).toBe(1)
        expect(r.pesoDespues).toBe(1)
    })

    it.each([{ precioCompra: 0 }, { unidadesCompra: 0 }, { fx: 0 }, { unidades: -1 }, { invertido: -1 }])(
        "rechaza datos no válidos (%o)",
        (cambio) => {
            expect(hScCalcular({ ...base, ...cambio })).toBeNull()
        }
    )
})

describe("hScRepartoCompras", () => {
    const compras = [
        { precio: 100, cantidad: 6 },
        { precio: 50, cantidad: 8 }
    ]

    it("pesa cada compra por su coste, antes y después de la simulada", () => {
        // 600 y 400 de 1000; con 1000 más, de 2000.
        const filas = hScRepartoCompras(compras, { precio: 80, cantidad: 12.5 })

        expect(filas.map((f) => f.etiqueta)).toEqual(["Esta compra", "Compra 1", "Compra 2"])
        expect(filas[0]).toMatchObject({ simulado: true, antes: 0, despues: 0.5 })
        expect(filas[1]).toMatchObject({ antes: 0.6, despues: 0.3 })
        expect(filas[2]).toMatchObject({ antes: 0.4, despues: 0.2 })
    })

    it("los pesos después suman 1", () => {
        const suma = hScRepartoCompras(compras, { precio: 7, cantidad: 3 }).reduce((t, f) => t + f.despues, 0)

        expect(suma).toBeCloseTo(1, 12)
    })

    it("sin compras previas la simulada es el 100 %", () => {
        expect(hScRepartoCompras([], { precio: 10, cantidad: 2 })).toEqual([
            { etiqueta: "Esta compra", precio: 10, cantidad: 2, antes: 0, despues: 1, simulado: true }
        ])
    })

    it("sin nada con coste no devuelve filas", () => {
        expect(hScRepartoCompras([], { precio: 0, cantidad: 0 })).toEqual([])
    })
})

describe("hScRepartos", () => {
    const cartera = [
        { id: "a", nombre: "A", valorEur: 600 },
        { id: "b", nombre: "B", valorEur: 400 },
        { id: "c", nombre: "C", valorEur: 0 }
    ]

    it("suma la compra al activo elegido y diluye el resto", () => {
        const filas = hScRepartos(cartera, "b", 1000)

        expect(filas.map((f) => f.id)).toEqual(["b", "a"])
        expect(filas[0]).toMatchObject({ simulado: true, antes: 0.4, despues: 0.7 })
        expect(filas[1]).toMatchObject({ simulado: false, antes: 0.6, despues: 0.3 })
    })

    it("un activo sin posición aparece si es el que se compra", () => {
        const filas = hScRepartos(cartera, "c", 1000)

        expect(filas.find((f) => f.id === "c")).toMatchObject({ antes: 0, despues: 0.5 })
    })

    it("los pesos finales suman 1", () => {
        const suma = hScRepartos(cartera, "a", 250).reduce((t, f) => t + f.despues, 0)

        expect(suma).toBeCloseTo(1, 12)
    })

    it("sin nada valorado no devuelve filas", () => {
        expect(hScRepartos([{ id: "x", nombre: "X", valorEur: 0 }], "y", 0)).toEqual([])
    })
})
