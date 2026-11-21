// Ventana de una cuenta (js/finanzas/cuentas-detalle.js): desglose del saldo,
// gastos fraccionados unidos y saldo tras cada transferencia.
//
// Lo delicado es que todo cuadre con el saldo que calcula el servidor: lo
// pendiente no cuenta, lo anterior al periodo va al saldo de partida y un
// fraccionado enseña el saldo tras pagar el total, no a medias.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/cuentas-graficos.js")
    cargarScript("js/finanzas/cuentas-detalle.js")
})

const t = (anio, mes, dia) => new Date(anio, mes - 1, dia).getTime()

const mov = (origen, kind, cantidad, dia, extra = {}) => ({
    origen,
    kind,
    cantidad,
    dia,
    pendiente: false,
    ...extra
})

const MOVIMIENTOS = [
    mov("transferencia", "salida", "7.00", ""),
    mov("ingreso", "entrada", "100.00", "2025-12-30"),
    mov("recurrente", "entrada", "1000.00", "2026-01-01"),
    mov("gasto", "salida", "20.00", "2026-01-05"),
    mov("mensualidad", "salida", "15.00", "2026-01-28"),
    mov("transferencia", "entrada", "50.00", "2026-02-01"),
    mov("transferencia", "salida", "300.00", "2026-02-02"),
    mov("comision", "salida", "1.50", "2026-02-02"),
    mov("interes", "entrada", "2.25", "2026-02-28"),
    mov("dividendo", "entrada", "4.00", "2026-03-01"),
    mov("mensualidad", "salida", "15.00", "2026-03-28", { pendiente: true })
]

describe("cntDesglose", () => {
    it("reparte el periodo por vía y lo anterior (y lo sin día) va al saldo de partida", () => {
        const { inicio, final, grupos } = cntDesglose(MOVIMIENTOS, t(2026, 1, 1), 10)

        expect(inicio).toBeCloseTo(10 - 7 + 100)
        expect(grupos).toEqual({
            ingresos: 1000,
            rendimientos: 6.25,
            recibidas: 50,
            gastos: 35,
            enviadas: 300,
            comisiones: 1.5
        })
        expect(final).toBeCloseTo(103 + 1000 + 6.25 + 50 - 35 - 300 - 1.5)
    })

    it("sin inicio de periodo, todo es del periodo y se parte del saldo inicial", () => {
        const { inicio, grupos } = cntDesglose(MOVIMIENTOS, null, 10)

        expect(inicio).toBe(10)
        expect(grupos.ingresos).toBe(1100)
        expect(grupos.enviadas).toBe(307)
    })

    it("lo anterior al inicio de la cuenta no cuenta ni en el periodo ni en el saldo de partida", () => {
        const movimientos = [
            mov("ingreso", "entrada", "100.00", "2026-01-05", { anterior: true }),
            mov("gasto", "salida", "30.00", "2026-02-05")
        ]

        expect(cntDesglose(movimientos, null, 500)).toMatchObject({ inicio: 500, final: 470 })
        expect(cntDesglose(movimientos, t(2026, 2, 1), 500)).toMatchObject({ inicio: 500, final: 470 })
    })

    it("lo pendiente no cuenta", () => {
        const { grupos } = cntDesglose(MOVIMIENTOS, t(2026, 3, 1), 0)

        expect(grupos.gastos).toBe(0)
        expect(grupos.rendimientos).toBe(4)
    })
})

describe("cntUnirFraccionados", () => {
    it("une la parte propia y la de otros con el saldo tras pagar el total", () => {
        const movimientos = [
            {
                origen: "gasto",
                kind: "salida",
                fecha: "12-11-2026",
                nombre: "Tokio",
                contraparte: TIPO_GASTO_FRACCIONADO,
                cantidad: "21.20",
                saldo: "78.80",
                orden: 3
            },
            {
                origen: "gasto",
                kind: "salida",
                fecha: "12-11-2026",
                nombre: "Tokio (parte de otros)",
                contraparte: TIPO_GASTO_FRACCIONADO,
                cantidad: "48.00",
                saldo: "30.80",
                orden: 4
            },
            {
                origen: "ingreso",
                kind: "entrada",
                fecha: "13-11-2026",
                nombre: "Devolución",
                contraparte: "",
                cantidad: "23.00",
                saldo: "53.80",
                orden: 5
            }
        ]

        const unidos = cntUnirFraccionados(movimientos)

        expect(unidos).toHaveLength(2)
        expect(unidos[0]).toMatchObject({ fraccionado: true, saldo: "30.80", orden: 4 })
        expect(parseEuroNumber(unidos[0].cantidad)).toBeCloseTo(69.2)
        expect(unidos[1].nombre).toBe("Devolución")
    })
})

describe("cntEnAnio", () => {
    it("«Todos» deja pasar cualquier año y lo que no tiene fecha", () => {
        expect(cntEnAnio({ year: "2025" }, CNT_TODOS_LOS_ANIOS)).toBe(true)
        expect(cntEnAnio({ year: "" }, CNT_TODOS_LOS_ANIOS)).toBe(true)
    })

    it("un año solo deja pasar ese, y «sin fecha» solo lo que no la tiene", () => {
        expect(cntEnAnio({ year: "2026" }, "2026")).toBe(true)
        expect(cntEnAnio({ year: "2025" }, "2026")).toBe(false)
        expect(cntEnAnio({ year: "" }, CNT_SIN_FECHA)).toBe(true)
        expect(cntEnAnio({ year: "2026" }, CNT_SIN_FECHA)).toBe(false)
    })
})

describe("cntSaldosTrasTransferencia", () => {
    it("toma el saldo tras la comisión cuando la hay", () => {
        const saldos = cntSaldosTrasTransferencia([
            { origen: "transferencia", id: 1, orden: 0, saldo: "90.00" },
            { origen: "comision", id: 1, orden: 1, saldo: "89.00" },
            { origen: "gasto", id: 1, orden: 2, saldo: "80.00" },
            { origen: "transferencia", id: 2, orden: 3, saldo: "120.00" }
        ])

        expect(saldos.get("1").saldo).toBe("89.00")
        expect(saldos.get("2").saldo).toBe("120.00")
        expect(saldos.size).toBe(2)
    })

    it("sin movimientos cargados está vacío", () => {
        expect(cntSaldosTrasTransferencia(undefined).size).toBe(0)
    })
})
