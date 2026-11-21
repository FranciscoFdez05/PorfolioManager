// Detalle de un movimiento en la ventana de una cuenta (js/finanzas/cuentas-detalle.js).
//
// Lo delicado es el saldo antes y después: una transferencia con comisión deja
// el saldo de después de la comisión, y lo de antes del inicio no tiene saldo.
import { beforeAll, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/cuentas-graficos.js")
    cargarScript("js/finanzas/cuentas.js")
    cargarScript("js/finanzas/cuentas-detalle.js")
    runInThisContext(`
        cntTransferencias = [
            { id: 7, fecha: "04-11-2026", origen: "banco", destino: "efectivo", origen_nombre: "Santander", destino_nombre: "Efectivo", cantidad: "50.00", comision: "1.50", concepto: "", nota: "Para el finde" }
        ]
        cntPanelMovimientos = {
            banco: [
                { origen: "transferencia", id: 7, kind: "salida", cantidad: "50.00", saldo: "150.00", orden: 4, dia: "2026-11-04" },
                { origen: "comision", id: 7, kind: "salida", cantidad: "1.50", saldo: "148.50", orden: 5, dia: "2026-11-04" }
            ],
            efectivo: [
                { origen: "transferencia", id: 7, kind: "entrada", cantidad: "50.00", saldo: "83.10", orden: 2, dia: "2026-11-04" }
            ]
        }
    `)
})

const valor = (filas, titulo) => filas.find(([t]) => t === titulo)?.[1]

describe("cntSaldosDelMovimiento", () => {
    it("un gasto: antes es el saldo de después más lo que salió", () => {
        expect(cntSaldosDelMovimiento({ kind: "salida", cantidad: "20.00", saldo: "80.00" }, null, "banco")).toEqual({
            antes: 100,
            despues: 80
        })
    })

    it("una transferencia con comisión: después de la comisión, antes de las dos", () => {
        const t = cntTransferencias[0]
        expect(cntSaldosDelMovimiento({ origen: "transferencia", id: 7 }, t, "banco")).toEqual({
            antes: 200,
            despues: 148.5
        })
        expect(cntSaldosDelMovimiento({ origen: "transferencia", id: 7 }, t, "efectivo")).toEqual({
            antes: 33.1,
            despues: 83.1
        })
    })

    it("lo de antes del inicio no tiene saldo", () => {
        expect(
            cntSaldosDelMovimiento({ kind: "salida", cantidad: "5", saldo: "", anterior: true }, null, "banco")
        ).toBeNull()
    })
})

describe("cntDatosDelDetalle", () => {
    it("transferencia enviada: destino, comisión, saldos y estado", () => {
        const filas = cntDatosDelDetalle(
            { origen: "comision", id: 7, fecha: "04-11-2026", dia: "2026-11-04" },
            cntTransferencias[0],
            "banco"
        )

        expect(valor(filas, "Tipo")).toBe("Transferencia · salida")
        expect(valor(filas, "Hacia")).toBe("Efectivo")
        expect(valor(filas, "Comisión")).toBe(formatEuro(-1.5))
        expect(valor(filas, "Saldo antes")).toBe(formatEuro(200))
        expect(valor(filas, "Saldo después")).toBe(formatEuro(148.5))
        expect(valor(filas, "Estado")).toBe("Contado en el saldo")
        expect(valor(filas, "Cuenta el día")).toBeUndefined()
    })

    it("gasto fraccionado: total, tu parte y la de otros", () => {
        const filas = cntDatosDelDetalle(
            {
                origen: "gasto",
                kind: "salida",
                fecha: "12-11-2026",
                nombre: "Tokio",
                cantidad: "69,20 €",
                parteOtros: "48.00",
                fraccionado: true,
                saldo: "10.00"
            },
            null,
            "banco"
        )

        expect(valor(filas, "Total pagado")).toBe(formatEuro(-69.2))
        expect(valor(filas, "Tu parte")).toBe(formatEuro(-21.2))
        expect(valor(filas, "Parte de otros")).toBe(formatEuro(48))
        expect(valor(filas, "Importe")).toBeUndefined()
    })

    it("pendiente: saldos previstos; fecha de la fila distinta del día en que cuenta", () => {
        const filas = cntDatosDelDetalle(
            {
                origen: "gasto",
                kind: "salida",
                fecha: "26-12-2025",
                dia: "2026-01-01",
                cantidad: "10",
                saldo: "5",
                pendiente: true
            },
            null,
            "banco"
        )

        expect(valor(filas, "Cuenta el día")).toBe("01-01-2026")
        expect(valor(filas, "Saldo después (previsto)")).toBe(formatEuro(5))
        expect(valor(filas, "Estado")).toMatch(/^Pendiente/)
    })

    it("antes del inicio: sin saldos", () => {
        const filas = cntDatosDelDetalle(
            { origen: "ingreso", kind: "entrada", fecha: "01-01-2026", cantidad: "10", saldo: "", anterior: true },
            null,
            "banco"
        )

        expect(valor(filas, "Saldo antes")).toBeUndefined()
        expect(valor(filas, "Estado")).toMatch(/^Antes del inicio/)
    })
})
