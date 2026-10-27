// Panel desplegable de la página de Fundamentales.
//
// Lo que se comprueba es lo que el panel promete al leerlo: que cada dato sale
// de su columna del scanner, que un dato que el instrumento no tiene no se
// pinta como si faltara (DeMark sin R2/R3, una cripto sin márgenes) y que el
// selector de pivotes lee la columna del periodo elegido.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/fundamentales.js")
})

beforeEach(() => {
    // Estado de módulo declarado con `let`: vive en el ámbito léxico global del
    // script, no en window, así que se cambia evaluando en ese mismo contexto.
    runInThisContext(`_fnPivotMethod = "Classic"; _fnPivotPeriod = "M"`)
})

function panel(html) {
    const div = document.createElement("div")
    div.innerHTML = html
    return div
}

function lineas(nodo) {
    return [...nodo.querySelectorAll(".fnDetailLine")].map((l) => l.firstElementChild.textContent)
}

describe("fnToNumber", () => {
    it.each([
        [null, null],
        [undefined, null],
        ["", null],
        ["abc", null],
        [0, 0],
        [-3.5, -3.5],
        ["12.5", 12.5]
    ])("%s -> %s", (entrada, esperado) => {
        expect(fnToNumber(entrada)).toBe(esperado)
    })
})

describe("fnUnixDate", () => {
    it("convierte segundos Unix a fecha", () => {
        expect(fnUnixDate(1793655000)).toContain("2026")
    })

    it("sin dato devuelve guion", () => {
        expect(fnUnixDate(null)).toBe("—")
    })
})

describe("fnDetailPivots", () => {
    const stats = {
        "Pivot.M.Classic.R1": 110,
        "Pivot.M.Classic.Middle": 100,
        "Pivot.M.Classic.S1": 90,
        "Pivot.M.Classic.Middle|240": 200,
        "Pivot.M.Demark.R1": 120,
        "Pivot.M.Demark.Middle": 105,
        "Pivot.M.Demark.S1": 95,
        "Pivot.M.Demark.R2": null,
        "Pivot.M.Demark.S2": null
    }

    it("pinta solo los niveles que publica el método", () => {
        runInThisContext(`_fnPivotMethod = "Demark"`)
        expect(lineas(panel(fnDetailPivots(stats, "EUR")))).toEqual(["R1", "P", "S1"])
    })

    it("el periodo semanal lee la columna con sufijo |240", () => {
        runInThisContext(`_fnPivotPeriod = "W"`)
        const nodo = panel(fnDetailPivots(stats, "EUR"))
        expect(lineas(nodo)).toEqual(["P"])
        expect(nodo.querySelector(".fnDetailPivotMid").textContent).toContain("200")
    })

    it("sin ningún nivel lo dice en vez de dejar el bloque vacío", () => {
        expect(panel(fnDetailPivots({}, "EUR")).querySelector(".fnNd")).not.toBeNull()
    })

    it("marca como elegidos el método y el periodo actuales", () => {
        runInThisContext(`_fnPivotMethod = "Fibonacci"; _fnPivotPeriod = "Y"`)
        const nodo = panel(fnDetailPivots(stats, "EUR"))
        const activos = [...nodo.querySelectorAll(".fnPivotChip.active")].map((b) => b.dataset.value)
        expect(activos.sort()).toEqual(["Fibonacci", "Y"])
    })

    it("no usa <select>: shared-utils los sustituiría dejando menús huérfanos en cada repintado", () => {
        expect(panel(fnDetailPivots(stats, "EUR")).querySelector("select")).toBeNull()
    })
})

describe("fnMaCell", () => {
    it("verde con el precio por encima de la media", () => {
        expect(panel(fnMaCell(90, 100, "EUR")).querySelector(".fnPos")).not.toBeNull()
    })

    it("rojo con el precio por debajo", () => {
        expect(panel(fnMaCell(110, 100, "EUR")).querySelector(".fnNeg")).not.toBeNull()
    })

    it("sin precio de referencia no colorea", () => {
        const nodo = panel(fnMaCell(110, null, "EUR"))
        expect(nodo.querySelector(".fnPos, .fnNeg")).toBeNull()
    })
})

describe("fnDetailFundamentals", () => {
    it("una cripto sin fundamentales muestra el aviso, no una lista de guiones", () => {
        const nodo = panel(fnDetailFundamentals({ gross_margin: null, free_cash_flow: null }, "EUR"))
        expect(lineas(nodo)).toEqual([])
        expect(nodo.querySelector(".fnNd")).not.toBeNull()
    })

    it("pinta solo las líneas con dato", () => {
        const nodo = panel(fnDetailFundamentals({ net_margin: 27.6, expense_ratio: 0.0945 }, "USD"))
        expect(lineas(nodo)).toEqual(["Margen neto", "Gastos corrientes (TER)"])
    })

    it("FCF en la divisa de los estados financieros, no en la de cotización", () => {
        const nodo = panel(fnDetailFundamentals({ free_cash_flow: 2e9, fundamental_currency_code: "USD" }, "EUR"))
        expect(nodo.textContent).toContain(currencySuffix("USD"))
        expect(nodo.textContent).not.toContain(currencySuffix("EUR"))
    })
})

describe("fnDetailRange", () => {
    it("añade la distancia del precio al máximo de 52 semanas", () => {
        const nodo = panel(fnDetailRange({ close: 75, price_52_week_high: 100 }, "EUR"))
        expect(nodo.querySelector(".fnDetailSub").textContent).toContain("-25,0 %")
    })
})

describe("fnBuildDetailHtml", () => {
    it("muestra los ratings parciales de medias y osciladores", () => {
        const nodo = panel(
            fnBuildDetailHtml({ currency: "EUR", stats: { "Recommend.MA": 0.6, "Recommend.Other": -0.2 } })
        )
        const badges = [...nodo.querySelectorAll(".fnRatingMini")].map((b) => b.textContent)
        expect(badges).toEqual(["Compra fuerte", "Venta"])
    })
})
