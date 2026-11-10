// Pagas extra y copia entre años de los ingresos recurrentes
// (js/finanzas/ingresos.js). La paga extra va sumada al mes en `meses`, que es
// lo que leen cuentas y métricas; aquí se comprueba que se separa bien del
// cobro normal y que no aparece donde el mes no tiene dinero.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/ingresos.js")
})

const MESES = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre"
]

function mesesCon(importe, claves = MESES) {
    return Object.fromEntries(MESES.map((mes) => [mes, claves.includes(mes) ? importe : ""]))
}

function nomina(extra = {}) {
    const pagasExtra = extra.pagasExtra ?? [{ nombre: "Extra", mes: "junio", importe: "1.000,00 €" }]
    return normalizeRecurrente({
        nombre: "Trabajo",
        importe: "1.500,00 €",
        frecuencia: "mensual",
        activa: true,
        pagasExtra,
        meses: sumarPagasExtraAMeses(mesesCon("1.500,00 €"), normalizePagasExtra(pagasExtra)),
        ...extra
    })
}

describe("normalizePagasExtra", () => {
    it("pone «Extra» si no hay nombre y descarta las que no tienen mes o importe", () => {
        expect(
            normalizePagasExtra([
                { mes: "junio", importe: "500" },
                { nombre: "Mala", mes: "junember", importe: "500" },
                { nombre: "Vacía", mes: "julio", importe: "" },
                null
            ])
        ).toEqual([{ nombre: "Extra", mes: "junio", importe: "500" }])
    })

    it("algo que no es una lista da una lista vacía", () => {
        expect(normalizePagasExtra(undefined)).toEqual([])
        expect(normalizePagasExtra("junio")).toEqual([])
    })
})

describe("sumarPagasExtraAMeses", () => {
    it("suma la paga al mes que toca y deja los demás igual", () => {
        const meses = sumarPagasExtraAMeses(mesesCon("1.500,00 €"), [
            { nombre: "Extra", mes: "junio", importe: "1.000,00 €" }
        ])
        expect(parseEuroNumber(meses.junio)).toBe(2500)
        expect(parseEuroNumber(meses.mayo)).toBe(1500)
    })

    it("una paga en un mes sin cobro normal crea ese cobro", () => {
        const meses = sumarPagasExtraAMeses(mesesCon(""), [{ nombre: "Extra", mes: "diciembre", importe: "300" }])
        expect(parseEuroNumber(meses.diciembre)).toBe(300)
        expect(meses.enero).toBe("")
    })

    it("no deja colas de coma flotante", () => {
        const meses = sumarPagasExtraAMeses(mesesCon("0,10 €", ["enero"]), [
            { nombre: "Extra", mes: "enero", importe: "0,20 €" }
        ])
        expect(parseEuroNumber(meses.enero)).toBe(0.3)
    })
})

describe("getRecurrenteDesglose", () => {
    it("separa el cobro normal de la paga extra", () => {
        const desglose = getRecurrenteDesglose(nomina())
        expect(desglose.junio).toEqual({ base: 1500, extra: 1000 })
        expect(desglose.enero).toEqual({ base: 1500, extra: 0 })
    })

    it("la extra no pasa del total del mes si se bajó a mano", () => {
        const row = nomina()
        row.meses.junio = "400,00 €"
        expect(getRecurrenteDesglose(row).junio).toEqual({ base: 0, extra: 400 })
    })

    it("un mes vacío no tiene extra aunque haya una paga definida", () => {
        const row = nomina()
        row.meses.junio = ""
        expect(getRecurrenteDesglose(row).junio).toEqual({ base: 0, extra: 0 })
    })
})

describe("importes de una recurrente con pagas extra", () => {
    it("el anual suma las pagas; el mensual y el cobro no", () => {
        const row = nomina()
        expect(getRecurrenteAnnualAmount(row)).toBe(1500 * 12 + 1000)
        expect(getRecurrenteExtraAnual(row)).toBe(1000)
        expect(getRecurrenteMonthlyAmount(row)).toBe(1500)
    })

    it("sin importe guardado, el cobro sale del último mes sin contar la extra", () => {
        const row = nomina({ pagasExtra: [{ nombre: "Navidad", mes: "diciembre", importe: "1.500,00 €" }] })
        row.importe = ""
        expect(getRecurrenteCobro(row)).toBe(1500)
    })
})

describe("getRecurrenteCobros", () => {
    it("da el cobro normal y la paga extra como entradas separadas", () => {
        const row = nomina({ diaCobro: "28" })
        const junio = getRecurrenteCobros(row, "2026").filter((cobro) => cobro.monthKey === "junio")
        expect(junio).toHaveLength(2)
        expect(junio.map((cobro) => [cobro.esExtra, cobro.amount, cobro.nombre])).toEqual([
            [false, 1500, "Trabajo"],
            [true, 1000, "Trabajo · Extra"]
        ])
        expect(junio[0].date.getDate()).toBe(28)
        expect(junio[0].sinDia).toBe(false)
    })

    it("en febrero el día 31 se queda en el último día del mes", () => {
        const row = nomina({ diaCobro: "31" })
        const febrero = getRecurrenteCobros(row, "2026").find((cobro) => cobro.monthKey === "febrero")
        expect(febrero.date.getDate()).toBe(28)
    })
})

describe("copiarRecurrenteParaOtroAnio", () => {
    it("una nómina copia los doce meses y vuelve a sumar su paga extra", () => {
        const copia = copiarRecurrenteParaOtroAnio(nomina())
        expect(copia.pagasExtra).toEqual([{ nombre: "Extra", mes: "junio", importe: "1.000,00 €" }])
        expect(parseEuroNumber(copia.meses.enero)).toBe(1500)
        expect(parseEuroNumber(copia.meses.junio)).toBe(2500)
        expect(copia.cuentasCobro).toEqual({})
    })

    it("una pausada sigue pausada y sin cobros, pero conserva sus pagas", () => {
        const copia = copiarRecurrenteParaOtroAnio(nomina({ activa: false }))
        expect(copia.activa).toBe(false)
        expect(Object.values(copia.meses).every((valor) => valor === "")).toBe(true)
        expect(copia.pagasExtra).toHaveLength(1)
    })

    it("una trimestral sigue el ritmo del año anterior", () => {
        const copia = copiarRecurrenteParaOtroAnio({
            nombre: "Alquiler local",
            importe: "900,00 €",
            frecuencia: "trimestral",
            activa: true,
            meses: mesesCon("900,00 €", ["febrero", "mayo", "agosto", "noviembre"])
        })
        const cobrados = MESES.filter((mes) => copia.meses[mes])
        expect(cobrados).toEqual(["febrero", "mayo", "agosto", "noviembre"])
    })
})

describe("getRecurrentesParaCopiar", () => {
    it("salta las que ya existen con el mismo concepto", () => {
        const { nuevas, omitidas } = getRecurrentesParaCopiar(
            [nomina(), { nombre: "Alquiler", importe: "600", activa: true, meses: mesesCon("600") }],
            [{ nombre: "trabajo", meses: {} }]
        )
        expect(omitidas).toBe(1)
        expect(nuevas.map((row) => row.nombre)).toEqual(["Alquiler"])
    })
})

describe("getMesSugeridoPagaExtra", () => {
    it("propone junio, luego diciembre y luego el primer mes libre", () => {
        expect(getMesSugeridoPagaExtra([])).toBe("junio")
        expect(getMesSugeridoPagaExtra(["junio"])).toBe("diciembre")
        expect(getMesSugeridoPagaExtra(["junio", "diciembre"])).toBe("enero")
    })
})

describe("formatRecCalImporte", () => {
    it("abrevia los miles y redondea lo demás", () => {
        expect(formatRecCalImporte(1500)).toBe("1,5k")
        expect(formatRecCalImporte(2000)).toBe("2k")
        expect(formatRecCalImporte(899.6)).toBe("900")
    })
})
