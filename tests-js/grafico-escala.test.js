// Escala del eje de precios (js/core/grafico-escala.js): el cálculo del rango al
// arrastrar el eje y la condición para ofrecer la escala logarítmica.
//
// jsdom no tiene canvas, así que Chart.js no se carga y el plugin no se registra;
// lo que se prueba son las funciones puras de las que depende.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/grafico-escala.js")
})

describe("escalaPrecioRango", () => {
    it("sin desplazamiento deja el rango igual", () => {
        expect(escalaPrecioRango(50, 70, 0, false)).toEqual({ min: 50, max: 70 })
    })

    it("arrastrar hacia arriba estrecha el rango y hacia abajo lo amplía, con el centro fijo", () => {
        const arriba = escalaPrecioRango(50, 70, -100, false)
        const abajo = escalaPrecioRango(50, 70, 100, false)
        expect(arriba.max - arriba.min).toBeLessThan(20)
        expect(abajo.max - abajo.min).toBeGreaterThan(20)
        expect((arriba.min + arriba.max) / 2).toBeCloseTo(60)
        expect((abajo.min + abajo.max) / 2).toBeCloseTo(60)
    })

    it("subir y bajar lo mismo vuelve al rango de partida", () => {
        const ida = escalaPrecioRango(50, 70, -80, false)
        const vuelta = escalaPrecioRango(ida.min, ida.max, 80, false)
        expect(vuelta.min).toBeCloseTo(50)
        expect(vuelta.max).toBeCloseTo(70)
    })

    it("en logarítmica estira sobre log10 y nunca baja de cero", () => {
        const rango = escalaPrecioRango(10, 1000, 300, true)
        expect(rango.min).toBeGreaterThan(0)
        // Centro geométrico: sqrt(10 * 1000) = 100.
        expect(Math.sqrt(rango.min * rango.max)).toBeCloseTo(100)
        expect(rango.max / rango.min).toBeGreaterThan(100)
    })

    it("rechaza rangos no válidos", () => {
        expect(escalaPrecioRango(70, 50, 10, false)).toBeNull()
        expect(escalaPrecioRango(5, 5, 10, false)).toBeNull()
        expect(escalaPrecioRango(Number.NaN, 5, 10, false)).toBeNull()
        expect(escalaPrecioRango(0, 100, 10, true)).toBeNull()
    })
})

describe("escalaPrecioRangoTiempo", () => {
    it("hacia la izquierda se ven menos días y hacia la derecha más, con el final fijo", () => {
        const derecha = escalaPrecioRangoTiempo(0, 100, 100)
        const izquierda = escalaPrecioRangoTiempo(0, 100, -100)
        expect(derecha.max).toBe(100)
        expect(izquierda.max).toBe(100)
        expect(izquierda.min).toBeGreaterThan(0)
        expect(derecha.min).toBeLessThan(0)
    })

    it("rechaza rangos no válidos", () => {
        expect(escalaPrecioRangoTiempo(100, 0, 10)).toBeNull()
        expect(escalaPrecioRangoTiempo(Number.NaN, 10, 10)).toBeNull()
    })
})

describe("escalaPrecioDesplazar", () => {
    it("mueve el rango sin cambiar su tamaño", () => {
        expect(escalaPrecioDesplazar(50, 70, 0.5, false)).toEqual({ min: 60, max: 80 })
        expect(escalaPrecioDesplazar(50, 70, -0.25, false)).toEqual({ min: 45, max: 65 })
    })

    it("en logarítmica conserva la proporción entre los extremos", () => {
        const rango = escalaPrecioDesplazar(10, 1000, 0.5, true)
        expect(rango.max / rango.min).toBeCloseTo(100)
        expect(rango.min).toBeCloseTo(100)
    })

    it("rechaza rangos no válidos", () => {
        expect(escalaPrecioDesplazar(70, 50, 0.1, false)).toBeNull()
        expect(escalaPrecioDesplazar(0, 50, 0.1, true)).toBeNull()
        expect(escalaPrecioDesplazar(10, 50, Number.NaN, false)).toBeNull()
    })
})

describe("escalaPrecioLimitar", () => {
    it("deja igual un rango cuyo centro cae dentro de los datos", () => {
        expect(escalaPrecioLimitar({ min: 10, max: 30 }, { min: 0, max: 100 })).toEqual({ min: 10, max: 30 })
    })

    it("devuelve el centro al borde de los datos sin cambiar el tamaño", () => {
        expect(escalaPrecioLimitar({ min: 150, max: 170 }, { min: 0, max: 100 })).toEqual({ min: 90, max: 110 })
        expect(escalaPrecioLimitar({ min: -60, max: -20 }, { min: 0, max: 100 })).toEqual({ min: -20, max: 20 })
    })

    it("sin extensión conocida no toca el rango", () => {
        expect(escalaPrecioLimitar({ min: 1, max: 2 }, null)).toEqual({ min: 1, max: 2 })
        expect(escalaPrecioLimitar(null, { min: 0, max: 1 })).toBeNull()
    })
})

describe("escalaPrecioExtensionX", () => {
    it("abarca todos los datasets, aunque estén fuera del encuadre", () => {
        const datasets = [{ data: [{ x: 50, y: 1 }, { x: 90, y: 2 }] }, { data: [{ x: 10, y: 3 }] }]
        expect(escalaPrecioExtensionX(datasets)).toEqual({ min: 10, max: 90 })
    })

    it("sin X numérica no hay extensión", () => {
        expect(escalaPrecioExtensionX([{ data: [1, 2, { x: null, y: 3 }] }])).toBeNull()
        expect(escalaPrecioExtensionX(undefined)).toBeNull()
    })
})

describe("escalaPrecioDatosPositivos", () => {
    it("acepta números y puntos {x, y} positivos", () => {
        expect(escalaPrecioDatosPositivos([{ data: [1, 2, 3] }, { data: [{ x: 1, y: 5 }] }])).toBe(true)
    })

    it("ignora huecos y datasets ocultos", () => {
        const datasets = [{ data: [null, { x: 1, y: null }, Number.NaN, 4] }, { hidden: true, data: [-5] }]
        expect(escalaPrecioDatosPositivos(datasets)).toBe(true)
    })

    it("un cero o un negativo descarta la escala logarítmica", () => {
        expect(escalaPrecioDatosPositivos([{ data: [3, 0] }])).toBe(false)
        expect(escalaPrecioDatosPositivos([{ data: [{ x: 1, y: -0.5 }] }])).toBe(false)
    })

    it("sin ningún valor no hay escala logarítmica", () => {
        expect(escalaPrecioDatosPositivos([])).toBe(false)
        expect(escalaPrecioDatosPositivos([{ data: [null] }])).toBe(false)
        expect(escalaPrecioDatosPositivos(undefined)).toBe(false)
    })
})
