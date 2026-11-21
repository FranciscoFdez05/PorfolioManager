// «Reiniciar cuentas» (js/finanzas/cuentas.js): fechas del formulario y saldo
// calculado a una fecha, que es lo que se precarga en cada casilla.
import { beforeAll, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

const t = (anio, mes, dia) => new Date(anio, mes - 1, dia).getTime()

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/cuentas-graficos.js")
    cargarScript("js/finanzas/cuentas.js")
    cargarScript("js/finanzas/cuentas-detalle.js")
    runInThisContext(`cntHistorico = {
        banco: [
            { fecha: "2026-01-09", entradas: "0", salidas: "0", saldo: "100.00" },
            { fecha: "2026-01-10", entradas: "50", salidas: "0", saldo: "150.00" },
            { fecha: "2026-02-01", entradas: "0", salidas: "20", saldo: "130.00" }
        ]
    }`)
})

describe("cntFechaInicioTexto", () => {
    it("pasa aaaa-mm-dd a dd-mm-aaaa y vacío a vacío", () => {
        expect(cntFechaInicioTexto("2026-03-01")).toBe("01-03-2026")
        expect(cntFechaInicioTexto("")).toBe("")
        expect(cntFechaInicioTexto(undefined)).toBe("")
    })
})

describe("cntInstanteDeTexto", () => {
    it("lee dd-mm-aaaa y rechaza lo que no es una fecha", () => {
        expect(cntInstanteDeTexto("05-02-2026")).toBe(t(2026, 2, 5))
        expect(cntInstanteDeTexto("31-02-2026")).toBeNull()
        expect(cntInstanteDeTexto("2026-02-05")).toBeNull()
    })
})

describe("cntSaldoAlFinalDe", () => {
    it("da el saldo del último punto de ese día o anterior", () => {
        expect(cntSaldoAlFinalDe("banco", t(2026, 1, 10))).toBe(150)
        expect(cntSaldoAlFinalDe("banco", t(2026, 1, 31))).toBe(150)
        expect(cntSaldoAlFinalDe("banco", t(2026, 3, 1))).toBe(130)
    })

    it("antes del primer punto es el saldo de partida; sin serie, null", () => {
        expect(cntSaldoAlFinalDe("banco", t(2025, 12, 1))).toBe(100)
        expect(cntSaldoAlFinalDe("nada", t(2026, 1, 1))).toBeNull()
    })
})
