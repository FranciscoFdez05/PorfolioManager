// Comparador de divisas: lo que se puede comprobar sin red ni gráfico.
//
// Dar la vuelta al par no pide nada al servidor: se invierte la serie que ya
// está en pantalla. Si esa inversión estuviera mal, el botón mostraría una
// cotización que no existe, así que es lo que más importa fijar.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-divisas.js")
})

const PAR = {
    base: "EUR",
    quote: "USD",
    rango: "1M",
    puntos: [
        { ts: 100, close: 1.0 },
        { ts: 200, close: 1.25 },
        { ts: 300, close: 2.0 }
    ],
    actual: { ts: 300, close: 2.0 },
    referencias: [{ rango: "1S", ts: 100, close: 1.25 }]
}

describe("hFxInvertirDatos", () => {
    it("intercambia las divisas y pasa cada cotización a 1/x", () => {
        const invertido = hFxInvertirDatos(PAR)

        expect(invertido.base).toBe("USD")
        expect(invertido.quote).toBe("EUR")
        expect(invertido.puntos.map((p) => p.close)).toEqual([1, 0.8, 0.5])
        expect(invertido.actual.close).toBe(0.5)
        expect(invertido.referencias[0].close).toBe(0.8)
    })

    it("conserva las fechas y no toca el original", () => {
        const invertido = hFxInvertirDatos(PAR)

        expect(invertido.puntos.map((p) => p.ts)).toEqual([100, 200, 300])
        expect(PAR.puntos[1].close).toBe(1.25)
    })

    it("dos vueltas devuelven el par de partida", () => {
        const vuelta = hFxInvertirDatos(hFxInvertirDatos(PAR))

        expect(vuelta.base).toBe("EUR")
        vuelta.puntos.forEach((p, i) => expect(p.close).toBeCloseTo(PAR.puntos[i].close, 12))
    })

    it("la variación del par invertido es la inversa exacta: 2→1 sube, y 0,5→1 baja", () => {
        // EUR/USD pasó de 1,25 a 2,0 (+60 %). USD/EUR pasó de 0,8 a 0,5 (-37,5 %).
        const inv = hFxInvertirDatos(PAR)
        const sube = (PAR.actual.close / PAR.referencias[0].close - 1) * 100
        const baja = (inv.actual.close / inv.referencias[0].close - 1) * 100

        expect(sube).toBeCloseTo(60, 10)
        expect(baja).toBeCloseTo(-37.5, 10)
    })
})

describe("formato", () => {
    it("usa menos decimales cuanto mayor es la cotización", () => {
        expect(hFxNumero(1.08421)).toBe("1,0842")
        expect(hFxNumero(158.0581)).toBe("158,058")
        expect(hFxNumero(0.006423)).toBe("0,00642")
    })

    it("los porcentajes llevan signo y dos decimales", () => {
        expect(hFxPorcentaje(0.424)).toBe("+0,42%")
        expect(hFxPorcentaje(-1.5)).toBe("-1,50%")
        expect(hFxPorcentaje(0)).toBe("0,00%")
    })

    it("la clase de color sigue el signo", () => {
        expect(hFxClaseVariacion(1)).toBe("hFxPos")
        expect(hFxClaseVariacion(-1)).toBe("hFxNeg")
        expect(hFxClaseVariacion(0)).toBe("")
    })

    it("las diferencias llevan signo y los decimales de la cotización de referencia", () => {
        expect(hFxDiferencia(0.0034, 1.0842)).toBe("+0,0034")
        expect(hFxDiferencia(-0.512, 158.058)).toBe("-0,512")
        expect(hFxDiferencia(0, 1.08)).toBe("0,0000")
    })

    it("el dinero va con dos decimales y signo", () => {
        expect(hFxDinero(1.234)).toBe("+1,23")
        expect(hFxDinero(-0.5)).toBe("-0,50")
        expect(hFxDinero(0)).toBe("0,00")
    })
})
