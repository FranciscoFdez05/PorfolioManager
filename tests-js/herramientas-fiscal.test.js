// Herramientas fiscales: doble imposición y desglose de la previsión del IRPF.
//
// La doble imposición sigue el art. 80 LIRPF: se deduce lo menor entre lo
// retenido fuera (como mucho, el límite del convenio) y lo que España cobraría
// por esa renta. Lo retenido por encima del convenio se reclama al otro país.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-fiscal.js")
})

describe("hFiscalHoy", () => {
    it("da la fecha en dd-mm-aaaa con ceros", () => {
        expect(hFiscalHoy(new Date(2026, 0, 5))).toBe("05-01-2026")
    })
})

describe("hDiCalcular", () => {
    it("retención igual al convenio y al tipo español: se recupera entera", () => {
        const r = hDiCalcular({ bruto: 100, origen: 15, convenio: 15, tipo: 19 })

        expect(r.retenido).toBeCloseTo(15, 10)
        expect(r.deduccion).toBeCloseTo(15, 10)
        expect(r.reclamable).toBe(0)
        expect(r.perdido).toBeCloseTo(0, 10)
        expect(r.aPagarEspana).toBeCloseTo(4, 10)
        // Lo que queda es lo mismo que si solo tributara en España.
        expect(r.neto).toBeCloseTo(81, 10)
    })

    it("lo retenido por encima del convenio es reclamable, no deducible", () => {
        const r = hDiCalcular({ bruto: 100, origen: 30, convenio: 15, tipo: 19 })

        expect(r.reclamable).toBeCloseTo(15, 10)
        expect(r.deduccion).toBeCloseTo(15, 10)
        expect(r.neto).toBeCloseTo(66, 10)
        expect(r.netoConReclamacion).toBeCloseTo(81, 10)
    })

    it("la deducción no supera la cuota española", () => {
        const r = hDiCalcular({ bruto: 100, origen: 25, convenio: 25, tipo: 19 })

        expect(r.deduccion).toBeCloseTo(19, 10)
        expect(r.perdido).toBeCloseTo(6, 10)
        expect(r.aPagarEspana).toBeCloseTo(0, 10)
    })

    it("sin retención en origen se paga todo en España", () => {
        const r = hDiCalcular({ bruto: 200, origen: 0, convenio: 15, tipo: 21 })

        expect(r.deduccion).toBe(0)
        expect(r.aPagarEspana).toBeCloseTo(42, 10)
    })

    it.each([
        [{ bruto: 0, origen: 15, convenio: 15, tipo: 19 }],
        [{ bruto: 100, origen: NaN, convenio: 15, tipo: 19 }],
        [{ bruto: 100, origen: 15, convenio: 120, tipo: 19 }],
        [{ bruto: 100, origen: 15, convenio: 15, tipo: -1 }]
    ])("devuelve null con datos no válidos (%o)", (datos) => {
        expect(hDiCalcular(datos)).toBeNull()
    })
})

describe("hIrpfFilasDesglose", () => {
    const prevision = {
        base: "900.00",
        tramos: { tramo2: "0.00", tramo1: "171.00", tramo3: "0.00", tramo4: "0.00", tramo5: "0.00" },
        rendimientos: {
            dividendosBrutos: "1000.00",
            dividendosCobros: 1,
            interesesBrutos: "200.00",
            interesesApuntes: 1
        },
        integracion: {
            saldoGyp: "-600.00",
            cruzadoGypContraRcm: "300.00",
            cruzadoRcmContraGyp: "0.00",
            arrastresAplicadosGyp: "0.00",
            arrastresAplicadosRcm: "0.00",
            perdidaArrastrable: "300.00"
        }
    }

    it("omite las compensaciones y tramos a cero y numera los tramos por su clave", () => {
        const conceptos = hIrpfFilasDesglose(prevision).map(([concepto]) => concepto)

        expect(conceptos).toEqual([
            "Dividendos brutos (1)",
            "Intereses brutos (1)",
            "Saldo de ganancias y pérdidas",
            "Pérdida compensada con rendimientos (25 %)",
            "Base liquidable del ahorro",
            "Cuota tramo 1",
            "Pérdida para los 4 años siguientes"
        ])
    })

    it("las compensaciones restan", () => {
        const filas = Object.fromEntries(hIrpfFilasDesglose(prevision))

        expect(filas["Pérdida compensada con rendimientos (25 %)"]).toBe(-300)
        expect(filas["Base liquidable del ahorro"]).toBe(900)
    })
})
