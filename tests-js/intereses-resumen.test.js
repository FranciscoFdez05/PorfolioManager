// Gráficas y resumen del año de la Cuenta Remunerada (js/finanzas/intereses-resumen.js).
//
// Todo sale de las filas de la tabla (fecha, acumulado bruto e impuestos) y,
// para la rentabilidad aproximada, del saldo de la cuenta enlazada. Lo que
// cubre este fichero:
//
//   1. **Agrupar por mes.** Varias filas del mismo mes se suman y las de otros
//      años o con fecha ilegible no entran.
//   2. **Cifras del resumen.** Bruto, media, mejor mes, retención, comparación
//      con el año anterior en los mismos meses y TAE aproximada, con null
//      cuando no se pueden calcular en vez de un 0 engañoso.
//   3. **Pintado.** La tarjeta y las gráficas siguen a la cuenta y al año
//      elegidos, y se ocultan cuando el año no tiene registros.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

beforeAll(() => {
    // Las pestañas de cuentas y años las desplaza app-core.js, que no se carga aquí.
    globalThis.refrescarTiraPestanas = () => {}
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/intereses.js")
    cargarScript("js/finanzas/intereses-resumen.js")
})

beforeEach(() => {
    document.body.innerHTML = readFileSync(resolve(RAIZ, "html/finanzas/intereses.html"), "utf-8")
    interesesSaldosCuentas = new Map()
    currentCuentaId = null
    currentInteresesYear = null
})

const fila = (fecha, acumulado, impuestos = "0,00") => ({ fecha, acumulado, impuestos })
const texto = (id) => document.getElementById(id).textContent.trim()

describe("mes de la fecha", () => {
    it("lee dd-mm-aaaa y mm-aaaa", () => {
        expect(parseInteresMes("01-05-2025")).toBe(4)
        expect(parseInteresMes("12-2025")).toBe(11)
    })

    it("devuelve null si la fecha no se puede leer", () => {
        expect(parseInteresMes("")).toBeNull()
        expect(parseInteresMes("pendiente")).toBeNull()
        expect(parseInteresMes("01-13-2025")).toBeNull()
        expect(parseInteresMes("01-00-2025")).toBeNull()
    })
})

describe("intereses por mes", () => {
    it("suma las filas del mismo mes y deja fuera otros años", () => {
        const meses = calcularInteresesPorMes(
            [fila("01-03-2025", "0,20", "0,04"), fila("15-03-2025", "0,10", "0,02"), fila("01-03-2024", "9,00")],
            "2025"
        )
        expect(meses[2].bruto).toBeCloseTo(0.3)
        expect(meses[2].impuestos).toBeCloseTo(0.06)
        expect(meses[2].neto).toBeCloseTo(0.24)
        expect(meses.filter((m) => m.conDatos)).toHaveLength(1)
    })

    it("acepta el año como número", () => {
        expect(calcularInteresesPorMes([fila("01-01-2025", "1")], 2025)[0].conDatos).toBe(true)
    })

    it("ignora filas con fecha ilegible", () => {
        expect(calcularInteresesPorMes([fila("sin fecha", "1")], "2025").some((m) => m.conDatos)).toBe(false)
    })
})

describe("resumen del año", () => {
    const rows = [
        fila("01-01-2025", "1,00", "0,20"),
        fila("01-02-2025", "3,00", "0,60"),
        fila("01-03-2025", "2,00", "0,40"),
        fila("01-01-2024", "1,00", "0,20"),
        fila("01-02-2024", "1,00", "0,20"),
        fila("01-03-2024", "1,00", "0,20"),
        // Fuera de los meses comparables con 2025 (que llega hasta marzo).
        fila("01-11-2024", "50,00", "10,00")
    ]

    it("calcula bruto, neto, media, mejor mes y retención", () => {
        const r = calcularResumenIntereses(rows, "2025", null)
        expect(r.bruto).toBeCloseTo(6)
        expect(r.impuestos).toBeCloseTo(1.2)
        expect(r.neto).toBeCloseTo(4.8)
        expect(r.mediaMensual).toBeCloseTo(1.6)
        expect(r.mejorMes).toEqual({ mes: 1, neto: expect.closeTo(2.4) })
        expect(r.retencion).toBeCloseTo(20)
    })

    it("compara con el año anterior solo en los mismos meses", () => {
        const r = calcularResumenIntereses(rows, "2025", null)
        expect(r.netoAnterior).toBeCloseTo(2.4)
        expect(r.variacion).toBeCloseTo(100)
    })

    it("sin año anterior no hay variación", () => {
        const r = calcularResumenIntereses(rows, "2024", null)
        expect(r.netoAnterior).toBeNull()
        expect(r.variacion).toBeNull()
    })

    it("sin bruto no hay retención ni media", () => {
        const r = calcularResumenIntereses([], "2025", null)
        expect(r.retencion).toBeNull()
        expect(r.mediaMensual).toBeNull()
        expect(r.mejorMes).toBeNull()
    })
})

describe("TAE aproximada", () => {
    const hoy = new Date(2025, 9, 15) // octubre de 2025

    it("divide el bruto de los últimos 12 meses entre el saldo", () => {
        const rows = [
            fila("01-11-2024", "10,00"), // entra: noviembre-2024 a octubre-2025
            fila("01-10-2025", "10,00"),
            fila("01-10-2024", "99,00"), // hace 13 meses: fuera
            fila("01-11-2025", "99,00") // futuro: fuera
        ]
        expect(calcularInteresesTae(rows, 1000, hoy)).toBeCloseTo(2)
    })

    it("sin saldo positivo o sin intereses recientes devuelve null", () => {
        expect(calcularInteresesTae([fila("01-10-2025", "10")], 0, hoy)).toBeNull()
        expect(calcularInteresesTae([fila("01-10-2025", "10")], null, hoy)).toBeNull()
        expect(calcularInteresesTae([fila("01-01-2020", "10")], 1000, hoy)).toBeNull()
    })
})

describe("pintado", () => {
    function cargarCuenta(rows, cuentaEnlazada = "c1") {
        loadCuentasFromData({ cuentas: [{ id: "r1", nombre: "Banco", cuenta: cuentaEnlazada, rows }] })
    }

    it("rellena la tarjeta y las dos gráficas del año elegido", () => {
        cargarCuenta([fila("01-01-2025", "1,00", "0,20"), fila("01-02-2025", "3,00", "0,60")])

        expect(document.getElementById("interesesGraficas").classList.contains("hidden")).toBe(false)
        expect(document.getElementById("interesesStatsCard").classList.contains("hidden")).toBe(false)
        expect(texto("interesesStatBruto")).toBe("4,00 €")
        expect(texto("interesesStatMejorMes")).toBe("2,40 €")
        expect(texto("interesesStatMejorMesNombre")).toBe("febrero")
        expect(texto("interesesStatRetencion")).toBe("20,00 %")
        expect(document.querySelectorAll("#interesesGraficaMensual .interesesGraficaBarra")).toHaveLength(2)
        expect(document.querySelectorAll("#interesesGraficaAcumulado .interesesGraficaDot")).toHaveLength(2)
    })

    it("usa el saldo de la cuenta enlazada para la TAE", () => {
        const mes = String(new Date().getMonth() + 1).padStart(2, "0")
        interesesSaldosCuentas = new Map([["c1", 1000]])
        cargarCuenta([fila(`01-${mes}-${new Date().getFullYear()}`, "10,00")])
        expect(texto("interesesStatTae")).toBe("1,00 %")
    })

    it("sin cuenta enlazada la TAE queda sin calcular", () => {
        interesesSaldosCuentas = new Map([["c1", 1000]])
        cargarCuenta([fila(`01-01-${new Date().getFullYear()}`, "10,00")], null)
        expect(texto("interesesStatTae")).toBe("—")
    })

    it("oculta gráficas y tarjeta si la cuenta no tiene registros", () => {
        cargarCuenta([])
        expect(document.getElementById("interesesGraficas").classList.contains("hidden")).toBe(true)
        expect(document.getElementById("interesesStatsCard").classList.contains("hidden")).toBe(true)
    })
})
