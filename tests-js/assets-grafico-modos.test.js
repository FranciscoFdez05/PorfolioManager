// Modos «Comparativa anual» y «Comparativa índices» del gráfico de la ficha: el cálculo
// de la rentabilidad por año y la alineación de los cierres de un índice con el activo.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const dia = 86400
const ts = (fecha) => Date.parse(`${fecha}T12:00:00`) / 1000
const punto = (fecha, precio) => ({ ts: ts(fecha), precio })

beforeAll(() => {
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets-grafico.js")
    cargarScript("js/cartera/assets-grafico-modos.js")
})

describe("rentabilidad por año", () => {
    it("cada año parte del último precio del anterior", () => {
        const filas = window.assetGraficoRentabilidadAnual([
            punto("2024-03-01", 100),
            punto("2024-12-30", 110),
            punto("2025-06-01", 120),
            punto("2025-12-30", 132)
        ])
        expect(filas.map((fila) => fila.anio)).toEqual([2024, 2025])
        expect(filas[0].rentabilidad).toBeCloseTo(10)
        expect(filas[0].parcial).toBe(true)
        expect(filas[1].rentabilidad).toBeCloseTo(20)
        expect(filas[1].parcial).toBe(false)
    })

    it("un año con un solo precio y sin año previo no delimita periodo", () => {
        expect(window.assetGraficoRentabilidadAnual([punto("2024-05-01", 100)])).toEqual([])
    })

    it("ignora precios vacíos o no positivos", () => {
        const filas = window.assetGraficoRentabilidadAnual([
            punto("2025-01-02", null),
            punto("2025-02-01", 0),
            punto("2025-03-01", 50),
            punto("2025-09-01", 75)
        ])
        expect(filas).toHaveLength(1)
        expect(filas[0].rentabilidad).toBeCloseTo(50)
    })

    it("sin puntos no hay filas", () => {
        expect(window.assetGraficoRentabilidadAnual([])).toEqual([])
        expect(window.assetGraficoRentabilidadAnual(undefined)).toEqual([])
    })
})

describe("variación de un índice", () => {
    const cierres = [
        { ts: ts("2026-01-02"), close: 100 },
        { ts: ts("2026-01-05"), close: 110 }
    ]

    it("arranca en 0 % y arrastra el último cierre en fines de semana", () => {
        const fechas = [ts("2026-01-03"), ts("2026-01-04"), ts("2026-01-05")]
        const variacion = window.assetGraficoVariacionIndice(fechas, cierres)
        expect(variacion[0]).toBe(0)
        expect(variacion[1]).toBe(0)
        expect(variacion[2]).toBeCloseTo(10)
    })

    it("devuelve null mientras no haya ningún cierre anterior", () => {
        const variacion = window.assetGraficoVariacionIndice([ts("2026-01-01") - dia, ts("2026-01-02")], cierres)
        expect(variacion).toEqual([null, 0])
    })

    it("sin cierres todo es null", () => {
        expect(window.assetGraficoVariacionIndice([1, 2], [])).toEqual([null, null])
    })
})

describe("estacionales", () => {
    it("coloca cada día en la misma posición todos los años", () => {
        expect(window.assetGraficoDiaEstacional(0, 1)).toBe(0)
        expect(window.assetGraficoDiaEstacional(1, 29)).toBe(59)
        expect(window.assetGraficoDiaEstacional(2, 1)).toBe(60)
        expect(window.assetGraficoDiaEstacional(11, 31)).toBe(365)
    })

    it("cada año parte del cierre del anterior y el primero es parcial", () => {
        const series = window.assetGraficoSeriesEstacionales([
            punto("2024-06-01", 100),
            punto("2024-12-31", 200),
            punto("2025-01-02", 210),
            punto("2025-03-01", 300)
        ])
        expect(series.map((serie) => serie.anio)).toEqual([2024, 2025])
        expect(series[0].parcial).toBe(true)
        expect(series[0].ultimo).toBeCloseTo(100)
        expect(series[1].parcial).toBe(false)
        expect(series[1].valores).toHaveLength(366)
        expect(series[1].valores[1]).toBeCloseTo(5)
        expect(series[1].valores[60]).toBeCloseTo(50)
        expect(series[1].valores[30]).toBeNull()
        expect(series[1].ultimo).toBeCloseTo(50)
        expect(series[1].ultimoDia).toBe(60)
        expect(series[1].precios[60]).toBe(300)
        expect(series[1].precios[30]).toBeNull()
    })

    it("con varios precios el mismo día se queda el último", () => {
        const series = window.assetGraficoSeriesEstacionales([
            punto("2025-12-31", 100),
            { ts: ts("2026-01-05") - 3600, precio: 120 },
            { ts: ts("2026-01-05") + 3600, precio: 110 }
        ])
        // 2025 tiene un solo precio y ningún año anterior: solo sirve de base.
        expect(series.map((serie) => serie.anio)).toEqual([2026])
        expect(series[0].valores[4]).toBeCloseTo(10)
    })

    it("descarta precios no válidos y un año suelto de un solo precio", () => {
        expect(window.assetGraficoSeriesEstacionales([punto("2025-05-01", 100), punto("2025-06-01", 0)])).toEqual([])
        expect(window.assetGraficoSeriesEstacionales(undefined)).toEqual([])
    })

    it("un año con un solo precio cuenta si hay año anterior", () => {
        const series = window.assetGraficoSeriesEstacionales([
            punto("2025-11-01", 90),
            punto("2025-12-31", 100),
            punto("2026-01-01", 103)
        ])
        expect(series.map((serie) => serie.anio)).toEqual([2025, 2026])
        expect(series[1].ultimo).toBeCloseTo(3)
    })

    describe("años seleccionados", () => {
        const disponibles = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]

        it("sin elección guardada marca los cinco más recientes", () => {
            expect(window.assetGraficoAniosSeleccionados(disponibles, null)).toEqual([2022, 2023, 2024, 2025, 2026])
            expect(window.assetGraficoAniosSeleccionados([2025, 2026], null)).toEqual([2025, 2026])
        })

        it("respeta los años elegidos, sueltos y en orden", () => {
            expect(window.assetGraficoAniosSeleccionados(disponibles, "2026,2019,2022")).toEqual([2019, 2022, 2026])
        })

        it("ignora los años guardados que este activo no tiene", () => {
            expect(window.assetGraficoAniosSeleccionados(disponibles, "2010,2020")).toEqual([2020])
        })

        it("si ninguno de los guardados existe, vuelve a los más recientes", () => {
            expect(window.assetGraficoAniosSeleccionados([2025, 2026], "2010,2011")).toEqual([2025, 2026])
        })

        it("quitarlos todos es una elección y deja la lista vacía", () => {
            expect(window.assetGraficoAniosSeleccionados(disponibles, "")).toEqual([])
        })
    })

    it("el año más reciente lleva el color del tema y los demás no se repiten", () => {
        expect(window.assetGraficoColorAnio(0, "#123456")).toBe("#123456")
        const colores = Array.from({ length: 20 }, (_valor, distancia) => window.assetGraficoColorAnio(distancia + 1, "#123456"))
        expect(new Set(colores).size).toBe(20)
    })
})

describe("configuración del gráfico de estacionales", () => {
    const serie = (anio, ultimoDia) => ({ anio, valores: new Array(366).fill(1), ultimoDia })

    it("una línea por año y el más reciente, más gruesa y con punto en su último día", () => {
        const config = window.assetGraficoConfigEstacional([serie(2024, 365), serie(2025, 100)], ["#a", "#b"], {
            texto: "#t",
            rejilla: "#r"
        })
        const [antiguo, reciente] = config.data.datasets

        expect(config.data.datasets.map((d) => d.label)).toEqual(["2024", "2025"])
        expect(config.options.scales.x.max).toBe(365)
        expect(reciente.borderWidth).toBeGreaterThan(antiguo.borderWidth)
        expect(reciente.pointRadius({ dataIndex: 100 })).toBeGreaterThan(0)
        expect(antiguo.pointRadius({ dataIndex: 365 })).toBe(0)
    })

    it("con divisa, el tooltip enseña el precio de ese día junto al %", () => {
        const precios = new Array(366).fill(null)
        precios[10] = 58695
        const conPrecio = { anio: 2026, valores: new Array(366).fill(5), precios, ultimoDia: 10 }
        const estilo = { texto: "#t", rejilla: "#r" }
        const contexto = (config, dia) => ({ dataset: config.data.datasets[0], raw: config.data.datasets[0].data[dia] })

        const config = window.assetGraficoConfigEstacional([conPrecio], ["#a"], estilo, "EUR")
        const etiqueta = config.options.plugins.tooltip.callbacks.label
        expect(etiqueta(contexto(config, 10))).toMatch(/^2026: \+5,00 %\s+·\s+58\.695,00 €$/)
        // Un día sin precio propio (fin de semana) se queda solo con el %.
        expect(etiqueta(contexto(config, 11))).toBe("2026: +5,00 %")

        const sinDivisa = window.assetGraficoConfigEstacional([conPrecio], ["#a"], estilo)
        expect(sinDivisa.options.plugins.tooltip.callbacks.label(contexto(sinDivisa, 10))).toBe("2026: +5,00 %")
    })

    it("en escala log dibuja el multiplicador y el tooltip sigue en %", () => {
        const valores = new Array(366).fill(null)
        valores[0] = 1000
        valores[1] = -50
        const config = window.assetGraficoConfigEstacional(
            [{ anio: 2023, valores, ultimoDia: 1 }],
            ["#a"],
            { texto: "#t", rejilla: "#r" },
            null,
            "log"
        )
        const datos = config.data.datasets[0].data

        expect(config.options.scales.y.type).toBe("logarithmic")
        expect(datos[0].y).toBeCloseTo(11)
        expect(datos[1].y).toBeCloseTo(0.5)
        // Un día sin precio sigue siendo un hueco y no un 0 %.
        expect(datos[2].y).toBeNull()
        const etiqueta = config.options.plugins.tooltip.callbacks.label
        expect(etiqueta({ dataset: config.data.datasets[0], raw: datos[1] })).toBe("2023: -50,00 %")
        expect(config.options.scales.y.ticks.callback(2)).toBe("+100,00 %")
    })

    it("las marcas del eje log son porcentajes redondos dentro del eje", () => {
        expect(window.assetGraficoMarcasLogEstacional(0.4, 12).map((valor) => Math.round((valor - 1) * 100))).toEqual([
            -50, -25, 0, 50, 100, 200, 400, 1000
        ])
        expect(window.assetGraficoMarcasLogEstacional(1.1, 1.2)).toEqual([])
    })

    it("por defecto la escala es lineal", () => {
        const config = window.assetGraficoConfigEstacional([serie(2025, 0)], ["#a"], { texto: "#t", rejilla: "#r" })
        expect(config.options.scales.y.type).toBeUndefined()
        expect(config.data.datasets[0].data[0].y).toBe(1)
    })
})
