// Pruebas del calendario del dinero (js/finanzas/calendario.js).
//
// La pantalla no guarda nada: coloca en un día cada movimiento de gastos e
// ingresos, cada cargo de mensualidad y cada ganancia recurrente, y suma. Lo
// que se comprueba aquí es la parte que decide dónde cae cada apunte y qué
// entra en la suma según los chips, que es donde un fallo no da un error sino
// un día con un importe que no es.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    // El orden es el de index.html: calendario.js usa la aritmética de las
    // mensualidades de gastos.js y normalizeRecurrente de ingresos.js.
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/ingresos.js")
    cargarScript("js/finanzas/calendario.js")
})

const HOY = new Date(2026, 5, 15, 10, 30)

const MESES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
]

const todosLosMeses = (valor) => Object.fromEntries(MESES.map((mes) => [mes, valor]))

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(HOY)
    calFinYear = "2026"
    calFinTipos = new Set(["gastos", "ingresos", "mensualidades"])
    calFinGastosData = { months: {}, mensualidades: [] }
    calFinIngresosData = { months: {}, recurrentes: [] }
})

describe("la fecha de un movimiento", () => {
    it("acepta DD-MM-AAAA y rechaza lo incompleto o imposible", () => {
        expect(calFinParseFecha("05-03-2026")).toEqual({ day: 5, monthIndex: 2, year: 2026 })
        expect(calFinParseFecha("31-02-2026")).toBeNull()
        expect(calFinParseFecha("05-03")).toBeNull()
        expect(calFinParseFecha("")).toBeNull()
    })

    it("pone el apunte en el día de su fecha, aunque esté apuntado en otro mes", () => {
        calFinGastosData.months.enero = { rows: [{ fecha: "03-02-2026", nombre: "Luz", cantidad: "40,00 €" }] }

        const [apunte] = getCalFinApuntes()
        expect(apunte.monthIndex).toBe(1)
        expect(apunte.date.getDate()).toBe(3)
        expect(apunte.sinDia).toBe(false)
    })

    it("sin fecha válida del año, el apunte se queda en su mes sin día", () => {
        calFinGastosData.months.marzo = {
            rows: [
                { fecha: "", nombre: "Sin fecha", cantidad: "10,00 €" },
                { fecha: "20-03-2025", nombre: "Otro año", cantidad: "10,00 €" }
            ]
        }

        const apuntes = getCalFinApuntes()
        expect(apuntes).toHaveLength(2)
        apuntes.forEach((apunte) => {
            expect(apunte.monthIndex).toBe(2)
            expect(apunte.sinDia).toBe(true)
        })
    })

    it("ignora las filas sin importe", () => {
        calFinGastosData.months.enero = { rows: [{ fecha: "01-01-2026", nombre: "Vacía", cantidad: "" }] }
        expect(getCalFinApuntes()).toHaveLength(0)
    })
})

describe("qué entra en el calendario", () => {
    beforeEach(() => {
        calFinGastosData.months.junio = { rows: [{ fecha: "10-06-2026", nombre: "Cena", cantidad: "30,00 €" }] }
        calFinIngresosData.months.junio = { rows: [{ fecha: "01-06-2026", nombre: "Nómina", cantidad: "1.500,00 €" }] }
        calFinGastosData.mensualidades = [
            { nombre: "Música", importe: "10,00 €", frecuencia: "mensual", diaCobro: "12", meses: todosLosMeses("10,00 €") }
        ]
        calFinIngresosData.recurrentes = [
            { nombre: "Alquiler", importe: "500,00 €", frecuencia: "mensual", diaCobro: "5", meses: todosLosMeses("500,00 €") }
        ]
    })

    it("con todo activo mezcla los cuatro orígenes ordenados por fecha", () => {
        const deJunio = getCalFinApuntes().filter((apunte) => apunte.monthIndex === 5)
        expect(deJunio.map((apunte) => `${apunte.date.getDate()} ${apunte.nombre}`)).toEqual([
            "1 Nómina",
            "5 Alquiler",
            "10 Cena",
            "12 Música"
        ])
    })

    it("las ganancias recurrentes cuentan como ingresos y las mensualidades van aparte de los gastos", () => {
        calFinTipos = new Set(["ingresos"])
        const ingresos = getCalFinApuntes()
        expect(ingresos.filter((apunte) => apunte.nombre === "Alquiler")).toHaveLength(12)
        expect(ingresos.filter((apunte) => apunte.nombre === "Nómina")).toHaveLength(1)
        expect(ingresos.every((apunte) => apunte.tipo === "ingresos")).toBe(true)

        calFinTipos = new Set(["gastos"])
        expect(getCalFinApuntes().map((apunte) => apunte.nombre)).toEqual(["Cena"])

        calFinTipos = new Set(["mensualidades"])
        expect(getCalFinApuntes()).toHaveLength(12)
    })

    it("el balance es lo que entra menos lo que sale", () => {
        const deJunio = getCalFinApuntes().filter((apunte) => apunte.monthIndex === 5)
        expect(calFinBalance(deJunio)).toBeCloseTo(1500 + 500 - 30 - 10)

        const totales = calFinTotalesPorTipo(deJunio)
        expect(totales.map((tipo) => [tipo.key, tipo.total])).toEqual([
            ["gastos", 30],
            ["ingresos", 2000],
            ["mensualidades", 10]
        ])
    })

    it("un cargo de mensualidad sin día se lista aparte, no el día 1", () => {
        calFinGastosData.mensualidades[0].diaCobro = ""
        calFinTipos = new Set(["mensualidades"])

        const [cargo] = getCalFinApuntes()
        expect(cargo.sinDia).toBe(true)
    })
})
