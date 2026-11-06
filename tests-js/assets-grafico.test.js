// Gráfico de la ficha del activo: lo que se pinta según la vista y la unidad, los
// cortes de la línea y cómo se agrupan los puntos de compra y venta.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const punto = (ts, valor, coste, precio) => ({ ts, valor, coste, precio })
const operacion = (tipo, indice, extra = {}) => ({
    tipo,
    indice,
    fecha: "01-01-2026",
    cantidad: 1,
    precio: 10,
    divisa: "EUR",
    ...extra
})

function datos(puntos, operaciones = [], segundosHueco = 1000) {
    return { puntos, operaciones, segundosHueco, operacionesSinPunto: 0 }
}

beforeAll(() => {
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets-grafico.js")
})

describe("valor de cada punto", () => {
    const serie = [punto(100, 200, 100, 20), punto(200, 300, 150, 25)]

    it("en precio y euros es el precio por participación", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "precio", "eur")
        expect(linea.map((p) => p.y)).toEqual([20, 25])
    })

    it("en precio y % es la variación desde el primer precio del periodo", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "precio", "pct")
        expect(linea.map((p) => p.y)).toEqual([0, 25])
    })

    it("en posición y euros es el valor menos el coste", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "posicion", "eur")
        expect(linea.map((p) => p.y)).toEqual([100, 150])
    })

    it("en posición y % es la ganancia sobre el coste de ese momento", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "posicion", "pct")
        expect(linea.map((p) => p.y)).toEqual([100, 100])
    })

    it("sin coste no inventa un porcentaje y sin precio deja el hueco", () => {
        const puntos = [punto(100, 200, 0, null), punto(200, 300, 0, 25)]
        expect(window.assetGraficoSeries(datos(puntos), "posicion", "pct").linea[0].y).toBeNull()
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").linea[0].y).toBeNull()
    })

    it("el % de precio parte del primer precio conocido, no del primer punto", () => {
        const puntos = [punto(100, 200, 0, null), punto(200, 300, 0, 20), punto(300, 300, 0, 30)]
        const { linea } = window.assetGraficoSeries(datos(puntos), "precio", "pct")
        expect(linea.map((p) => p.y)).toEqual([null, 0, 50])
    })
})

describe("línea", () => {
    it("se corta en un hueco mayor que el permitido y no en uno menor", () => {
        const puntos = [punto(100, 1, 1, 1), punto(500, 1, 1, 1), punto(5000, 1, 1, 1)]
        const { linea } = window.assetGraficoSeries(datos(puntos), "precio", "eur")
        expect(linea.map((p) => p.y)).toEqual([1, 1, null, 1])
    })

    it("encuentra los extremos y el último valor ignorando los cortes", () => {
        const puntos = [punto(100, 1, 1, 10), punto(200, 1, 1, 5), punto(5000, 1, 1, 8)]
        const { extremos, ultimo } = window.assetGraficoSeries(datos(puntos), "precio", "eur")
        expect(extremos.maximo.y).toBe(10)
        expect(extremos.minimo.y).toBe(5)
        expect(ultimo.y).toBe(8)
    })
})

describe("eje horizontal", () => {
    it("abarca solo los puntos con valor en esa vista", () => {
        const puntos = [punto(100, 200, 100, null), punto(200, 300, 150, 25), punto(300, 300, 150, 26)]
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").limitesX).toEqual({ min: 200, max: 300 })
        expect(window.assetGraficoSeries(datos(puntos), "posicion", "eur").limitesX).toEqual({ min: 100, max: 300 })
    })

    it("un punto suelto antes del trazo no estira el eje ni cuenta como extremo", () => {
        const puntos = [
            punto(100, 1, 1, 90),
            punto(200, 1, 1, null),
            punto(300, 1, 1, 20),
            punto(400, 1, 1, 25)
        ]
        const series = window.assetGraficoSeries(datos(puntos), "precio", "eur")
        expect(series.limitesX).toEqual({ min: 300, max: 400 })
        expect(series.extremos.maximo.y).toBe(25)
    })

    it("el % de precio tampoco parte de un punto suelto", () => {
        const puntos = [
            punto(100, 1, 1, 90),
            punto(200, 1, 1, null),
            punto(300, 1, 1, 20),
            punto(400, 1, 1, 25)
        ]
        const { linea } = window.assetGraficoSeries(datos(puntos), "precio", "pct")
        expect(linea.map((p) => p.y)).toEqual([350, null, 0, 25])
    })

    it("con un único punto suelto ese es el inicio", () => {
        const puntos = [punto(100, 1, 1, null), punto(200, 1, 1, 20), punto(300, 1, 1, null)]
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").limitesX).toEqual({ min: 200, max: 200 })
    })

    it("no tiene límites si no hay nada que pintar", () => {
        const puntos = [punto(100, 200, 100, null)]
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").limitesX).toBeNull()
    })

    it("escribe la hora, el día o el mes según el tramo visible", () => {
        const ts = Date.UTC(2026, 9, 15, 12) / 1000
        const dia = 86400
        const conHora = window.assetGraficoFormatearEje(ts, dia)
        const conDia = window.assetGraficoFormatearEje(ts, 30 * dia)
        const conMes = window.assetGraficoFormatearEje(ts, 365 * dia)
        expect(conHora).toMatch(/\d{2}:\d{2}/)
        expect(conDia).toContain("15")
        expect(conMes).toContain("26")
        expect(conMes).not.toContain("15")
    })
})

describe("puntos de compra y venta", () => {
    const serie = [punto(100, 200, 100, 20), punto(200, 300, 150, 25)]

    it("separa las compras de las ventas y los coloca sobre la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 0), operacion("venta", 1)]),
            "precio",
            "eur"
        )
        expect(series.compras).toHaveLength(1)
        expect(series.compras[0]).toMatchObject({ x: 100, y: 20, indiceLinea: 0 })
        expect(series.ventas[0]).toMatchObject({ x: 200, y: 25, indiceLinea: 1 })
    })

    it("varias compras del mismo punto comparten marca", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 0), operacion("compra", 0, { cantidad: 2 })]),
            "precio",
            "eur"
        )
        expect(series.compras).toHaveLength(1)
        expect(series.compras[0].operaciones).toHaveLength(2)
    })

    it("la marca sigue siendo la del punto correcto tras un corte de la línea", () => {
        const puntos = [punto(100, 1, 1, 1), punto(5000, 2, 1, 2)]
        const series = window.assetGraficoSeries(datos(puntos, [operacion("venta", 1)]), "precio", "eur")
        expect(series.linea[series.ventas[0].indiceLinea].y).toBe(2)
    })

    it("en la vista de precio la marca sale al precio de la operación, no al de la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 })]),
            "precio",
            "eur"
        )
        expect(series.compras[0]).toMatchObject({ x: 200, y: 22, indiceLinea: 1 })
    })

    it("en precio y % la marca usa la misma base que la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 })]),
            "precio",
            "pct"
        )
        expect(series.compras[0].y).toBeCloseTo(10)
    })

    it("en la vista de posición la marca sigue sobre la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 })]),
            "posicion",
            "eur"
        )
        expect(series.compras[0].y).toBe(150)
    })

    it("sin precio en euros la marca se apoya en la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: null })]),
            "precio",
            "eur"
        )
        expect(series.compras[0].y).toBe(25)
    })

    it("dos compras del mismo punto a precios distintos no comparten marca", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 }), operacion("compra", 1, { precioEur: 24 })]),
            "precio",
            "eur"
        )
        expect(series.compras.map((marca) => marca.y)).toEqual([22, 24])
    })

    it("sin valor en esa vista no pinta la marca, pero la cuenta para avisar", () => {
        const puntos = [punto(100, 1, 1, null), punto(200, 2, 1, 2)]
        const series = window.assetGraficoSeries(datos(puntos, [operacion("compra", 0)]), "precio", "eur")
        expect(series.compras).toHaveLength(0)
        expect(series.operacionesSinValor).toBe(1)
    })
})

describe("nota al pie", () => {
    const serie = { operacionesSinValor: 0 }

    it("dice desde cuándo hay histórico y cuántas operaciones faltan", () => {
        const texto = window.assetGraficoTextoNota(
            { inicioHistorico: 1779000000, operacionesSinPunto: 2 },
            serie,
            "precio",
            "EUR"
        )
        expect(texto).toContain("Histórico disponible desde")
        expect(texto).toContain("2 operaciones")
    })

    it("avisa de los euros solo si el activo está en otra divisa", () => {
        const enEuros = window.assetGraficoTextoNota({ operacionesSinPunto: 0 }, serie, "precio", "EUR")
        const enDolares = window.assetGraficoTextoNota({ operacionesSinPunto: 0 }, serie, "precio", "USD")
        expect(enEuros).toBe("")
        expect(enDolares).toContain("en euros")
    })

    it("en la vista de posición aclara que lo vendido no suma", () => {
        const texto = window.assetGraficoTextoNota({ operacionesSinPunto: 0 }, serie, "posicion", "EUR")
        expect(texto).toContain("Lo ya vendido no suma")
    })
})
