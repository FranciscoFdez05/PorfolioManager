// Copia de mensualidades de un año a otro (js/finanzas/gastos.js): al crear un
// año o desde «Copiar mensualidades de otro año». Lo que importa es que los
// cobros sigan el ritmo del año de origen, que las pausadas no generen cargos
// y que no se dupliquen las que ya existen.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
})

const VACIOS = {
    enero: "",
    febrero: "",
    marzo: "",
    abril: "",
    mayo: "",
    junio: "",
    julio: "",
    agosto: "",
    septiembre: "",
    octubre: "",
    noviembre: "",
    diciembre: ""
}

function mesesCon(importe, claves) {
    return { ...VACIOS, ...Object.fromEntries(claves.map((clave) => [clave, importe])) }
}

function mesesCobrados(row) {
    return Object.entries(row.meses)
        .filter(([, valor]) => valor)
        .map(([clave]) => clave)
}

describe("getAnioOrigenMensualidades", () => {
    it("elige el año anterior más cercano", () => {
        expect(getAnioOrigenMensualidades("2027", ["2026", "2024", "2025"])).toBe("2026")
    })

    it("sin años anteriores, elige el posterior más cercano", () => {
        expect(getAnioOrigenMensualidades("2023", ["2026", "2024"])).toBe("2024")
    })

    it("ignora el propio año y devuelve null si no hay otro", () => {
        expect(getAnioOrigenMensualidades("2026", ["2026"])).toBeNull()
        expect(getAnioOrigenMensualidades("2026", [])).toBeNull()
    })
})

describe("copiarMensualidadParaOtroAnio", () => {
    it("una mensual dada de alta a mitad de año se cobra los doce meses del siguiente", () => {
        const copia = copiarMensualidadParaOtroAnio({
            nombre: "Spotify",
            importe: "11,99 €",
            frecuencia: "mensual",
            diaCobro: "9",
            cuenta: "santander",
            nota: "familiar",
            meses: mesesCon("11,99 €", ["septiembre", "octubre", "noviembre", "diciembre"])
        })

        expect(mesesCobrados(copia)).toHaveLength(12)
        expect(copia.meses.enero).toBe("11,99 €")
        expect(copia).toMatchObject({
            nombre: "Spotify",
            importe: "11,99 €",
            frecuencia: "mensual",
            diaCobro: "9",
            cuenta: "santander",
            nota: "familiar",
            activa: true
        })
    })

    it("una trimestral cobrada por última vez en noviembre sigue en febrero", () => {
        const copia = copiarMensualidadParaOtroAnio({
            nombre: "Seguro",
            importe: "30,00 €",
            frecuencia: "trimestral",
            meses: mesesCon("30,00 €", ["febrero", "mayo", "agosto", "noviembre"])
        })

        expect(mesesCobrados(copia)).toEqual(["febrero", "mayo", "agosto", "noviembre"])
    })

    it("una anual se cobra el mismo mes", () => {
        const copia = copiarMensualidadParaOtroAnio({
            nombre: "AppleCare",
            frecuencia: "anual",
            meses: mesesCon("99,00 €", ["marzo"])
        })

        expect(mesesCobrados(copia)).toEqual(["marzo"])
        expect(copia.meses.marzo).toBe("99,00 €")
    })

    it("sin importe guardado usa el del último mes cobrado, que es el precio vigente", () => {
        const copia = copiarMensualidadParaOtroAnio({
            nombre: "Netflix",
            frecuencia: "mensual",
            meses: { ...mesesCon("8,99 €", ["enero", "febrero"]), marzo: "10,99 €" }
        })

        expect(copia.meses.diciembre).toBe("10,99 €")
    })

    it("una pausada sigue pausada y sin cargos", () => {
        const copia = copiarMensualidadParaOtroAnio({
            nombre: "Office",
            importe: "10,00 €",
            frecuencia: "mensual",
            activa: false,
            meses: mesesCon("10,00 €", ["enero", "febrero"])
        })

        expect(copia.activa).toBe(false)
        expect(mesesCobrados(copia)).toEqual([])
        expect(copia.importe).toBe("10,00 €")
    })

    it("no arrastra las excepciones por mes del año de origen", () => {
        const copia = copiarMensualidadParaOtroAnio({
            nombre: "iCloud",
            importe: "2,99 €",
            frecuencia: "mensual",
            diaCobro: "19",
            diasCobro: { marzo: "20" },
            cuentasCobro: { marzo: "tarjeta" },
            meses: mesesCon("2,99 €", ["enero"])
        })

        expect(copia.diasCobro).toEqual({})
        expect(copia.cuentasCobro).toEqual({})
    })
})

describe("getMensualidadesParaCopiar", () => {
    const origen = [
        { nombre: "Claude", importe: "22,00 €", frecuencia: "mensual", meses: mesesCon("22,00 €", ["diciembre"]) },
        { nombre: "Proton", importe: "19,99 €", frecuencia: "mensual", meses: mesesCon("19,99 €", ["diciembre"]) },
        { nombre: "", meses: VACIOS }
    ]

    it("copia todas si el destino está vacío y salta las filas sin nombre", () => {
        const { nuevas, omitidas } = getMensualidadesParaCopiar(origen, [])
        expect(nuevas.map((row) => row.nombre)).toEqual(["Claude", "Proton"])
        expect(omitidas).toBe(0)
    })

    it("no duplica las que ya existen, sin distinguir mayúsculas", () => {
        const { nuevas, omitidas } = getMensualidadesParaCopiar(origen, [{ nombre: "claude" }])
        expect(nuevas.map((row) => row.nombre)).toEqual(["Proton"])
        expect(omitidas).toBe(1)
    })

    it("tolera listas ausentes", () => {
        expect(getMensualidadesParaCopiar(undefined, undefined)).toEqual({ nuevas: [], omitidas: 0 })
    })
})
