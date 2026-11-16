// Tabla de rendimiento mensual por años de la ficha lateral.
//
// Se comprueba el cálculo: cada mes contra el cierre del mes anterior, el año
// contra el último cierre del año anterior, los huecos como null en vez de
// comparar con un mes más lejano, y el recuento de subidas y caídas.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/fundamentales.js")
    cargarScript("js/cartera/assets-mercado.js")
    cargarScript("js/cartera/assets-detalle-mercado.js")
})

// Vela mensual como la da el feed: el primer día del mes en UTC.
const vela = (anyo, mes, cierre) => [Date.UTC(anyo, mes, 1) / 1000, cierre]

describe("detMkTablaMensual", () => {
    it("calcula cada mes sobre el anterior y el año sobre el diciembre previo", () => {
        const { anyos } = detMkTablaMensual([
            vela(2024, 11, 100),
            vela(2025, 0, 110),
            vela(2025, 1, 99),
            vela(2025, 2, 120)
        ])

        expect(anyos.map((f) => f.anyo)).toEqual([2025, 2024])
        const [actual, previo] = anyos
        expect(actual.meses[0]).toBeCloseTo(10)
        expect(actual.meses[1]).toBeCloseTo(-10)
        expect(actual.meses[2]).toBeCloseTo((120 / 99 - 1) * 100)
        expect(actual.meses.slice(3)).toEqual(Array(9).fill(null))
        expect(actual.total).toBeCloseTo(20)
        // Un año con una sola vela y sin año anterior no tiene con qué compararse.
        expect(previo.meses[11]).toBeNull()
        expect(previo.total).toBeNull()
    })

    it("en el primer año compara con su primer cierre", () => {
        const { anyos } = detMkTablaMensual([vela(2020, 3, 50), vela(2020, 4, 60), vela(2020, 5, 75)])

        expect(anyos[0].meses[3]).toBeNull()
        expect(anyos[0].total).toBeCloseTo(50)
    })

    it("deja en null el mes que sigue a un hueco del proveedor", () => {
        const { anyos } = detMkTablaMensual([vela(2023, 0, 100), vela(2023, 2, 150), vela(2023, 3, 300)])

        expect(anyos[0].meses[1]).toBeNull()
        expect(anyos[0].meses[2]).toBeNull()
        expect(anyos[0].meses[3]).toBeCloseTo(100)
    })

    it("cuenta subidas y caídas por columna, incluido el año", () => {
        const { recuento } = detMkTablaMensual([
            vela(2022, 11, 100),
            vela(2023, 0, 90),
            vela(2023, 11, 120),
            vela(2024, 0, 130),
            vela(2024, 11, 110)
        ])

        expect(recuento).toHaveLength(13)
        expect(recuento[0]).toEqual({ subidas: 1, caidas: 1 })
        expect(recuento[12]).toEqual({ subidas: 1, caidas: 1 })
    })

    it("ignora velas sin cierre válido y acepta la entrada vacía", () => {
        expect(detMkTablaMensual(null)).toEqual({ anyos: [], recuento: Array(13).fill({ subidas: 0, caidas: 0 }) })
        const { anyos } = detMkTablaMensual([vela(2025, 0, 0), vela(2025, 1, 10), vela(2025, 2, 11)])
        expect(anyos[0].meses[1]).toBeNull()
        expect(anyos[0].meses[2]).toBeCloseTo(10)
    })
})

describe("detMkHtmlTablaMensual", () => {
    it("pinta una fila por año, la columna Año y el pie de subidas y caídas", () => {
        const div = document.createElement("div")
        div.innerHTML = detMkHtmlTablaMensual([vela(2024, 11, 100), vela(2025, 0, 110), vela(2025, 1, 99)])

        const filas = [...div.querySelectorAll("tbody tr")]
        expect(filas.map((f) => f.querySelector("th").textContent)).toEqual(["2025", "2024"])
        expect(div.querySelectorAll("thead th")).toHaveLength(14)
        expect(filas[0].querySelector(".detMkTablaAnyo").textContent).toBe("-1,00 %")
        expect(filas[0].querySelector(".detMkTablaAnyo").classList.contains("detMkTablaNeg")).toBe(true)
        expect(div.querySelector("tfoot th").textContent).toBe("Subidas y caídas")
    })

    it("sin histórico enseña un mensaje en vez de una tabla vacía", () => {
        expect(detMkHtmlTablaMensual([])).toContain("Sin histórico mensual")
    })
})

describe("detMkEstBotonesAnios", () => {
    const series = [
        { anio: 2024, ultimo: -5, parcial: true },
        { anio: 2025, ultimo: 12.5, parcial: false }
    ]

    it("ordena del año más reciente al más antiguo y marca los que se ven", () => {
        const botones = detMkEstBotonesAnios(series, [2025], (anio) => `c${anio}`)

        expect(botones.map((b) => b.anio)).toEqual([2025, 2024])
        expect(botones.map((b) => b.activo)).toEqual([true, false])
        expect(botones[0]).toMatchObject({ color: "c2025", etiqueta: "2025", valor: "+12,50 %", positivo: true })
    })

    it("señala con asterisco el año que no parte del cierre del anterior", () => {
        const [, antiguo] = detMkEstBotonesAnios(series, [], () => "")

        expect(antiguo).toMatchObject({ etiqueta: "2024 *", valor: "-5,00 %", positivo: false })
    })
})
