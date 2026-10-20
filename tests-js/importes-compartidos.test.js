// El parser del navegador y `dinero.aDecimal` del servidor leen igual los importes.
//
// La tabla de entradas es tests-js/importes-casos.json; tests/test_importes_casos_compartidos.py
// comprueba el otro extremo contra los mismos valores esperados. Antes cada
// mitad leía a su manera el punto sin coma ("0.001" daba 1 en pantalla y 0,001
// en el servidor).
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

const TABLA = resolve(dirname(fileURLToPath(import.meta.url)), "importes-casos.json")
const CASOS = JSON.parse(readFileSync(TABLA, "utf-8")).casos

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
})

describe("parseDecimalStrict contra la tabla compartida con el servidor", () => {
    it.each(CASOS.map((caso) => [caso.entrada, caso.esperado]))("lee %j como %j", (entrada, esperado) => {
        const leido = parseDecimalStrict(entrada)

        if (esperado === null) {
            expect(leido).toBeNull()
        } else {
            expect(Number(leido)).toBe(Number(esperado))
        }
    })
})

describe("los lectores tolerantes dan el mismo número que el estricto cuando éste entiende la entrada", () => {
    it.each(CASOS.filter((caso) => caso.esperado !== null).map((caso) => [caso.entrada, Number(caso.esperado)]))(
        "%j",
        (entrada, esperado) => {
            // parseEuroNumber solo quita el símbolo del euro; el del dólar es cosa de parseDollarNumber.
            if (!entrada.includes("$")) expect(parseEuroNumber(entrada)).toBe(esperado)
            expect(parseLooseNumber(entrada)).toBe(esperado)
        }
    )

    it("los ilegibles por ambigüedad de separadores dan 0 y null, no un número a medias", () => {
        for (const entrada of ["1.234.567", "1,2,3"]) {
            expect(parseEuroNumber(entrada)).toBe(0)
            expect(parseLooseNumber(entrada)).toBeNull()
        }
    })
})

describe("el punto es siempre decimal", () => {
    it.each([
        ["0.001", 0.001],
        ["0.123", 0.123],
        ["1.500", 1.5],
        ["12.000", 12]
    ])("%j se lee como %f y no como miles", (entrada, esperado) => {
        expect(parseEuroNumber(entrada)).toBe(esperado)
        expect(parseLooseNumber(entrada)).toBe(esperado)
    })
})

describe("coma y punto a la vez: el último es el decimal (solo navegador)", () => {
    it("lee el formato en-US sin multiplicar ni dividir por mil", () => {
        expect(parseEuroNumber("1,234.56 €")).toBe(1234.56)
        expect(parseLooseNumber("12,345.678")).toBe(12345.678)
    })
})

describe("toCanonicalNumber", () => {
    afterEach(() => {
        window._numLocale = "es-ES"
    })

    it("deja en canónico lo que se teclea en es-ES", () => {
        window._numLocale = "es-ES"
        expect(toCanonicalNumber("1.234,56 €")).toBe("1234.56")
        expect(toCanonicalNumber("0,001")).toBe("0.001")
        expect(toCanonicalNumber(" 12 ")).toBe("12")
        expect(toCanonicalNumber("+3,5")).toBe("3.5")
        expect(toCanonicalNumber("0.001")).toBe("0.001")
    })

    it("con en-US, la coma de miles se quita", () => {
        window._numLocale = "en-US"
        expect(toCanonicalNumber("1,234.56")).toBe("1234.56")
        expect(toCanonicalNumber("1,234")).toBe("1234")
        expect(toCanonicalNumber("12,345,678")).toBe("12345678")
        expect(toCanonicalNumber("0.5")).toBe("0.5")
    })

    it("con es-ES, '1,234' es un decimal (uno coma doscientos treinta y cuatro)", () => {
        window._numLocale = "es-ES"
        expect(toCanonicalNumber("1,234")).toBe("1.234")
    })

    it("lo ilegible se devuelve tal cual, recortado, para que lo valide el servidor", () => {
        expect(toCanonicalNumber(" abc ")).toBe("abc")
        expect(toCanonicalNumber("")).toBe("")
        expect(toCanonicalNumber(null)).toBe("")
    })

    it("lo canónico es lo que el servidor entiende: una vuelta completa por el formato de pantalla", () => {
        for (const locale of ["es-ES", "en-US", "fr-FR"]) {
            window._numLocale = locale
            for (const valor of [0.001, 1234.56, 1234567.89, 0.5]) {
                expect(Number(toCanonicalNumber(formatEuro(valor)))).toBeCloseTo(valor, 2)
            }
        }
    })
})
